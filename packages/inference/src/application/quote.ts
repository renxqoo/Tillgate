import type { Endpoint } from '@tillgate/ai';
import type { InferenceDefaults } from '../config';
import { InferenceErrors } from '../domain/errors';
import { buildCandidateChain } from '../domain/model/candidates';
import {
  clampForwardedOutputLimit,
  clampOutputCapByContext,
  conservativeInputTokenUpperBound,
  maxOutputTokensFor,
} from '../domain/model/output-cap';
import type { QuoteCandidate, RequestAuth } from '../domain/model/types';
import { estimateInputTokensOfBody } from '../domain/usage/estimate';
import type { CatalogPort } from '../ports/catalog';
import type { CalibrationLookup, CalibrationLookupConfig } from '../ports/calibration';
import {
  buildMessageHashChain,
  calibrationGuard,
  resolveCalibration,
  type CalibrationResolution,
} from './calibration';

/**
 * 请求预检：
 * 白名单 → 目录解析与候选链 → 输出上界与转发体钳制 → 双口径输入估算
 * → 校准解析（读侧；命中给主候选盖 calibratedInputTokenUpperBound）。
 *
 * 估算三口径（docs/calibrated-exposure-estimate.md §2.3 双界）：
 *   inputUpperBound（字节界）——authorize/reserveChannel 的保守底，B2 钳制唯一口径；
 *   calibratedInputTokenUpperBound（校准界，可选）——经济性收缩（仅命中候选），
 *     B2/死信阈值永不消费（I0 安全分离）；
 *   inputEstimate（特征校准估算）——缺 usage 的实扣兜底。
 */
export interface PreparedRequest {
  requestId: string;
  auth: RequestAuth;
  externalModel: string;
  /** 原始请求体（计量参数源） */
  body: Record<string, unknown>;
  /** 钳制输出上限后的转发体（「预估敞口 ≥ 实际输出」的结构性保证） */
  upstreamBody: Record<string, unknown>;
  endpoint: Endpoint;
  outputCap: number;
  /** 敞口口径：JSON 字节保守上界（保守底；B2 钳制唯一口径） */
  inputUpperBound: number;
  /** 实扣兜底口径：特征校准估算（缺 usage 收据消费） */
  inputEstimate: number;
  candidates: QuoteCandidate[];
  /** 校准解析结果（读侧；null = 不适用/未装配/守卫排除——观测与授权快照消费） */
  calibration: CalibrationResolution | null;
  /** 授权快照载荷（gateway 组 quote jsonb 的 calibration 子对象；null 同上） */
  calibrationSnapshot: QuoteCalibrationSnapshot | null;
}

/** quote.calibration 快照（docs §3.2a——授权/预留/结算三处消费同一快照） */
export interface QuoteCalibrationSnapshot {
  mappingId: number;
  prefixHash: string;
  channelId: number;
  /** 上一笔实测 inputTokens（seen） */
  inputTokens: number;
  messagesLen: number;
  /** C7b 写入守卫基准（前缀规范化字节长） */
  prefixBytes: number;
  /** 生效值快照（v3-R5：授权/预留/结算同值） */
  cacheRatio: number;
}

export async function prepareChatRequest(env: {
  catalog: CatalogPort;
  defaults: InferenceDefaults;
  requestId: string;
  auth: RequestAuth;
  body: Record<string, unknown>;
  endpoint?: Endpoint;
  /** 请求准入时刻（schedule 分时段选价锚点；runChat 入口捕获一次） */
  now: Date;
  /** 校准读侧（未装配 = 不解析——行为与现状逐字节一致） */
  calibration?: {
    lookup: CalibrationLookup;
    config: CalibrationLookupConfig;
  };
}): Promise<PreparedRequest> {
  // 模型白名单（凭证 scope）：预扣前拒绝——受限凭证调未授权模型的越权计费
  const externalModel = typeof env.body.model === 'string' ? env.body.model : '';
  if (env.auth.allowedModels != null && !env.auth.allowedModels.includes(externalModel)) {
    throw InferenceErrors.business('model_not_allowed', { model: externalModel });
  }
  const pricing = { userId: env.auth.userId, body: env.body, now: env.now };
  const mapping = await env.catalog.findMapping(externalModel, pricing);
  if (mapping == null) {
    throw InferenceErrors.business('model_not_found', { model: externalModel });
  }
  const candidates = await buildCandidateChain(mapping, (m) => env.catalog.findMapping(m, pricing));

  const endpoint = env.endpoint ?? 'chat';
  let kind: 'chat' | 'embeddings' | 'modality' = 'modality';
  if (endpoint === 'chat') kind = 'chat';
  else if (endpoint === 'embeddings') kind = 'embeddings';
  const outputCap = maxOutputTokensFor(kind, env.body, {
    defaultMax: env.defaults.output.defaultMaxOutputTokens,
    exposureCap: env.defaults.output.exposureCap,
  });
  const inputUpperBound = conservativeInputTokenUpperBound(env.body);
  const effectiveOutputCap = clampOutputCapByContext(
    outputCap,
    mapping.contextLength,
    inputUpperBound,
  );
  const upstreamBody = clampForwardedOutputLimit(env.body, effectiveOutputCap);

  const resolved = await resolveQuoteCalibration(env, {
    userId: env.auth.userId,
    candidates,
    endpoint,
    body: env.body,
    now: env.now,
  });

  return {
    requestId: env.requestId,
    auth: env.auth,
    externalModel,
    body: env.body,
    upstreamBody,
    endpoint,
    outputCap: effectiveOutputCap,
    inputUpperBound,
    inputEstimate: estimateInputTokensOfBody(env.body, env.defaults.estimate),
    candidates: resolved.candidates,
    calibration: resolved.resolution,
    calibrationSnapshot: resolved.snapshot,
  };
}

/**
 * 读侧校准解析（§2.2 C1-C6）：守卫 → 哈希链 → top-N 现读 → 匹配。
 * 命中时给 mappingId 匹配的候选盖 calibratedInputTokenUpperBound（seen + 尾部字节界）
 * ——仅命中候选，链上其余保字节界（tokenizer 漂移安全，D3/D12）。
 * 读失败（存储抖动）按未装配处理：回落保守（安全方向），不阻断请求。
 */
async function resolveQuoteCalibration(
  env: {
    auth: RequestAuth;
    body: Record<string, unknown>;
    endpoint?: Endpoint;
    now: Date;
    calibration?: { lookup: CalibrationLookup; config: CalibrationLookupConfig };
  },
  input: {
    userId: number;
    candidates: QuoteCandidate[];
    endpoint: Endpoint;
    body: Record<string, unknown>;
    now: Date;
  },
): Promise<{
  candidates: QuoteCandidate[];
  resolution: CalibrationResolution | null;
  snapshot: QuoteCalibrationSnapshot | null;
}> {
  const { calibration } = env;
  if (calibration == null) {
    return { candidates: input.candidates, resolution: null, snapshot: null };
  }
  // C6 守卫（§2.0'：读写双侧同款——非 chat 族/空 messages 不参与）
  if (!calibrationGuard({ endpoint: input.endpoint, body: input.body })) {
    return { candidates: input.candidates, resolution: { hit: false, missReason: 'guard' }, snapshot: null };
  }
  if (!calibration.config.enabled) {
    return { candidates: input.candidates, resolution: { hit: false, missReason: 'disabled' }, snapshot: null };
  }
  const chain = buildMessageHashChain({ body: input.body });
  if (chain == null) {
    return { candidates: input.candidates, resolution: { hit: false, missReason: 'guard' }, snapshot: null };
  }
  const primary = input.candidates[0];
  if (primary == null) {
    return { candidates: input.candidates, resolution: { hit: false, missReason: 'guard' }, snapshot: null };
  }
  let records;
  try {
    records = await calibration.lookup.findRecent({
      userId: input.userId,
      mappingId: primary.mappingId,
      limit: calibration.config.recentLimit,
    });
  } catch {
    // 存储抖动：回落保守（安全方向）——不阻断请求
    return { candidates: input.candidates, resolution: { hit: false, missReason: 'no_record' }, snapshot: null };
  }
  const resolution = resolveCalibration({
    config: {
      enabled: true,
      windowMs: calibration.config.windowMs,
      windowMarginMs: 30_000, // C4 结构常量（v3-R7：路由+有界等待上界）
    },
    records,
    chain,
    now: input.now,
  });
  if (!resolution.hit) {
    return { candidates: input.candidates, resolution, snapshot: null };
  }
  // 尾部字节界：只对新增尾部消息算保守界（已见部分用实测 seen）
  const tailTokens = tailUpperBound(input.body, resolution.messagesLen);
  const calibratedBound = resolution.seen + tailTokens;
  const stamped = input.candidates.map((c) =>
    c.mappingId === primary.mappingId ? { ...c, calibratedInputTokenUpperBound: calibratedBound } : c,
  );
  const prefixBytes = prefixBytesOf(input.body);
  return {
    candidates: stamped,
    resolution,
    snapshot: {
      mappingId: primary.mappingId,
      prefixHash: resolution.prefixHash,
      channelId: resolution.channelId,
      inputTokens: resolution.seen,
      messagesLen: resolution.messagesLen,
      prefixBytes,
      cacheRatio: calibration.config.cacheRatio,
    },
  };
}

/** 尾部消息（index ≥ from）的 JSON 字节保守上界 */
function tailUpperBound(body: Record<string, unknown>, from: number): number {
  const messages = body.messages;
  if (!Array.isArray(messages)) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(messages.slice(from)), 'utf8');
  } catch {
    return 0;
  }
}

/** 前缀规范化字节长（C7b 写入守卫基准——结算侧镜像判定用） */
function prefixBytesOf(body: Record<string, unknown>): number {
  try {
    return Buffer.byteLength(JSON.stringify(body.messages ?? []), 'utf8');
  } catch {
    return 0;
  }
}
