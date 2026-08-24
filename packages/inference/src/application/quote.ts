import type { Endpoint } from '@tokenlens/ai';
import type { InferenceDefaults } from '../config';
import { InferenceErrors } from '../domain/errors';
import { buildCandidateChain } from '../domain/model/candidates';
import {
  clampForwardedOutputLimit,
  conservativeInputTokenUpperBound,
  maxOutputTokensFor,
} from '../domain/model/output-cap';
import type { QuoteCandidate, RequestAuth } from '../domain/model/types';
import { estimateInputTokensOfBody } from '../domain/usage/estimate';
import type { CatalogPort } from '../ports/catalog';

/**
 * 请求预检（v1 runChat 前置段迁移，限流/OTel 剥离归 app）：
 * 白名单 → 目录解析与候选链 → 输出上界与转发体钳制 → 双口径输入估算。
 *
 * 估算双口径（v1 政策）：inputUpperBound（JSON UTF-8 字节保守上界）只作预扣敞口
 * /渠道预算——宁可多押；inputEstimate（特征校准估算）供缺 usage 的实扣兜底
 * ——实扣向精确收敛，上界入实扣会出现「残缺交付贵于完整交付」的反直觉账单。
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
  /** 敞口口径：JSON 字节保守上界（authorize/reserveChannel 消费） */
  inputUpperBound: number;
  /** 实扣兜底口径：特征校准估算（缺 usage 收据消费） */
  inputEstimate: number;
  candidates: QuoteCandidate[];
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
  const upstreamBody = clampForwardedOutputLimit(env.body, outputCap);
  return {
    requestId: env.requestId,
    auth: env.auth,
    externalModel,
    body: env.body,
    upstreamBody,
    endpoint,
    outputCap,
    inputUpperBound: conservativeInputTokenUpperBound(env.body),
    inputEstimate: estimateInputTokensOfBody(env.body, env.defaults.estimate),
    candidates,
  };
}
