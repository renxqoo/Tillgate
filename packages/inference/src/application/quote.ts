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
  type CalibrationRecord,
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

/**
 * quote.calibration 快照（docs §3.2a——授权/预留/结算三处消费同一快照）。
 * 冷启动闭环修正：前缀事实（hash/len/bytes）在守卫通过时**始终**携带——
 * 结算写入不依赖「本请求命中」（否则无人命中→无人写记录→永远无人命中）；
 * channelId/inputTokens/cacheRatio 仅命中时有值（读侧消费）。
 */
export interface QuoteCalibrationSnapshot {
  mappingId: number;
  prefixHash: string;
  /** 命中才有：校准记录渠道（金额分段与 B4 二级上界的渠道匹配键） */
  channelId: number | null;
  /** 命中才有：上一笔实测 inputTokens（seen） */
  inputTokens: number | null;
  messagesLen: number;
  /** C7b 写入守卫基准（前缀规范化字节长） */
  prefixBytes: number;
  /** 命中才有：生效值快照（v3-R5：授权/预留/结算同值） */
  cacheRatio: number | null;
}

/** 白名单 + 目录解析 + 候选链（prepareChatRequest 的模型解析段） */
async function resolveModelChain(env: {
  catalog: CatalogPort;
  auth: RequestAuth;
  body: Record<string, unknown>;
  now: Date;
}): Promise<{
  externalModel: string;
  candidates: QuoteCandidate[];
  mapping: NonNullable<Awaited<ReturnType<CatalogPort['findMapping']>>>;
}> {
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
  return { externalModel, candidates, mapping };
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
  const { externalModel, candidates, mapping } = await resolveModelChain(env);

  const endpoint = env.endpoint ?? 'chat';
  const { effectiveOutputCap, inputUpperBound, upstreamBody } = outputCapsOf({
    endpoint,
    body: env.body,
    defaults: env.defaults,
    contextLength: mapping.contextLength,
  });

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
// eslint-disable-next-line max-lines-per-function -- 读侧五段（守卫/事实/现读/匹配/盖章拆分后剩余编排）
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
  const passed = calibrationGatePass(calibration, input);
  if (passed.early != null) {
    // guard 类 miss 无前缀事实；disabled 携带前缀事实（P3：写侧不受读侧开关影响）
    const snapshot: QuoteCalibrationSnapshot | null = passed.baseSnapshot ?? null;
    return { candidates: input.candidates, resolution: passed.early, snapshot };
  }
  const { chain, primary, baseSnapshot } = passed;
  const records = await readCalibrationRecords(calibration, input, primary.mappingId);
  if (records == null) {
    // 存储抖动：回落保守（安全方向）——不阻断请求（前缀事实保留：写入不受读失败影响）
    return {
      candidates: input.candidates,
      resolution: { hit: false, missReason: 'no_record' },
      snapshot: baseSnapshot,
    };
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
    return { candidates: input.candidates, resolution, snapshot: baseSnapshot };
  }
  // 盖章恒随 enabled（渠道侧金额消费 calibratedInputTokenUpperBound——独立于
  // user_side）；user_side 门在 gateway toQuoteCandidate 透传处（用户冻结面）
  return stampCalibrated({
    candidates: input.candidates,
    body: input.body,
    baseSnapshot,
    resolution,
    cacheRatio: calibration.config.cacheRatio,
  });
}

/** 命中盖章输入（stampCalibrated 参数对象） */
interface StampInput {
  candidates: QuoteCandidate[];
  body: { messages?: unknown };
  baseSnapshot: QuoteCalibrationSnapshot;
  resolution: Extract<CalibrationResolution, { hit: true }>;
  cacheRatio: number;
}

/** 命中盖章：主候选盖校准界（seen + 尾部字节界）；快照填命中值 */
function stampCalibrated(input: StampInput): {
  candidates: QuoteCandidate[];
  resolution: CalibrationResolution;
  snapshot: QuoteCalibrationSnapshot;
} {
  const [primary] = input.candidates;
  if (primary == null) {
    return { candidates: input.candidates, resolution: input.resolution, snapshot: input.baseSnapshot };
  }
  // 尾部字节界：只对新增尾部消息算保守界（已见部分用实测 seen）
  const tailTokens = tailUpperBound(input.body, input.resolution.messagesLen);
  const calibratedBound = input.resolution.seen + tailTokens;
  const stamped = input.candidates.map((c) =>
    c.mappingId === primary.mappingId
      ? { ...c, calibratedInputTokenUpperBound: calibratedBound }
      : c,
  );
  return {
    candidates: stamped,
    resolution: input.resolution,
    snapshot: {
      ...input.baseSnapshot,
      channelId: input.resolution.channelId,
      inputTokens: input.resolution.seen,
      cacheRatio: input.cacheRatio,
    },
  };
}

/** 输出上限段输入（outputCapsOf 参数对象） */
interface OutputCapsInput {
  endpoint: Endpoint;
  body: Record<string, unknown>;
  defaults: InferenceDefaults;
  contextLength: number | null | undefined;
}

/** 输出上限/字节界/转发体三件套（prepareChatRequest 的上限段） */
function outputCapsOf(input: OutputCapsInput): {
  effectiveOutputCap: number;
  inputUpperBound: number;
  upstreamBody: Record<string, unknown>;
} {
  const { endpoint, body, defaults, contextLength } = input;
  let kind: 'chat' | 'embeddings' | 'modality' = 'modality';
  if (endpoint === 'chat') kind = 'chat';
  else if (endpoint === 'embeddings') kind = 'embeddings';
  const outputCap = maxOutputTokensFor(kind, body, {
    defaultMax: defaults.output.defaultMaxOutputTokens,
    exposureCap: defaults.output.exposureCap,
  });
  const inputUpperBound = conservativeInputTokenUpperBound(body);
  const effectiveOutputCap = clampOutputCapByContext(outputCap, contextLength, inputUpperBound);
  const upstreamBody = clampForwardedOutputLimit(body, effectiveOutputCap);
  return { effectiveOutputCap, inputUpperBound, upstreamBody };
}

/** 守卫 + 链 + 前缀事实构造（early = 守卫未过的 miss 结果） */
function calibrationGatePass(
  calibration: { config: CalibrationLookupConfig },
  input: { endpoint: Endpoint; body: Record<string, unknown>; candidates: QuoteCandidate[] },
):
  | { early: CalibrationResolution; baseSnapshot?: QuoteCalibrationSnapshot }
  | {
      early: null;
      chain: NonNullable<ReturnType<typeof buildMessageHashChain>>;
      primary: QuoteCandidate;
      baseSnapshot: QuoteCalibrationSnapshot;
    } {
  // C6 守卫（§2.0'：读写双侧同款——非 chat 族/空 messages 不参与）
  if (!calibrationGuard({ endpoint: input.endpoint, body: input.body })) {
    return { early: { hit: false, missReason: 'guard' } };
  }
  const built = buildMessageHashChain({ body: input.body });
  const [primary] = input.candidates;
  if (built == null || primary == null) {
    return { early: { hit: false, missReason: 'guard' } };
  }
  const chain = built;
  // 前缀事实（冷启动闭环：无论命中与否、enabled 开关如何都携带——结算写入
  // 的输入；P3 修复：enabled 只门控「查询+盖章」，不门控事实构造，否则
  // 灰度期零积累、打开时刻冷启动零命中——docs §3.3「写侧不受 enabled 门控」）
  const baseSnapshot: QuoteCalibrationSnapshot = {
    mappingId: primary.mappingId,
    prefixHash: chain.chainAt(chain.messageHashes.length),
    channelId: null,
    inputTokens: null,
    messagesLen: chain.messageHashes.length,
    prefixBytes: prefixBytesOf(input.body),
    cacheRatio: null,
  };
  if (!calibration.config.enabled) {
    // 读侧关闭：带前缀事实返回（miss reason 供观测）——chain/primary 不再需要
    return { early: { hit: false, missReason: 'disabled' }, baseSnapshot };
  }
  return { early: null, chain, primary, baseSnapshot };
}

/** top-N 现读（存储抖动 → null = 调用方安全回落） */
async function readCalibrationRecords(
  calibration: { lookup: CalibrationLookup; config: CalibrationLookupConfig },
  input: { userId: number },
  mappingId: number,
): Promise<readonly CalibrationRecord[] | null> {
  try {
    return await calibration.lookup.findRecent({
      userId: input.userId,
      mappingId,
      limit: calibration.config.recentLimit,
    });
  } catch {
    return null;
  }
}

/** 尾部消息（index ≥ from）的 JSON 字节保守上界 */
function tailUpperBound(body: { messages?: unknown }, from: number): number {
  const { messages } = body;
  if (!Array.isArray(messages)) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(messages.slice(from)), 'utf8');
  } catch {
    return 0;
  }
}

/** 前缀规范化字节长（C7b 写入守卫基准——结算侧镜像判定用） */
/**
 * 前缀规范化字节长（C7b 守卫基准——P8：与哈希链 h_sys 覆盖面对齐，
 * 计入 {system, tools, messages} 全量；只算 messages 会让大 system +
 * 极小 messages 的低报收据绕过 bytes/4 物理下限）。
 */
function prefixBytesOf(body: { system?: unknown; tools?: unknown; messages?: unknown }): number {
  try {
    return Buffer.byteLength(
      JSON.stringify({ system: body.system ?? null, tools: body.tools ?? null, messages: body.messages ?? [] }),
      'utf8',
    );
  } catch {
    return 0;
  }
}
