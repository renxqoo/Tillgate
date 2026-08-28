import type { RequestAuth } from '../model/types';
import type { QuoteCandidate } from '../model/types';
import { measurementOf } from './measurement';
import type { EstimateAttribution } from './attribution';

/**
 * 收据装配——
 * 结算验收消费的 durable 快照：价格取自授权时候的命中候选（防中途改价，fallback
 * 价同样有效），usage 取自上游可信回执；缺 usage 走估算归属政策
 * （usage_missing_nonstream ∈ 白名单）。流式专属字段（stream/streamAborted/
 * estimatedFor/bytesRelayed/TTFT）由流式层在基础收据上覆写。
 *
 * 单位计量（units）：按命中候选声明的 pricingUnit 走计量注册表取结算实值——
 * 响应实值优先（images 张数），参数兜底（audio 秒 / speech 字符）；
 * token 模型 units 恒 0。units 是结算公式 unitPrice × units 的计数源——
 * 不装配即 0 元结算（漏收）。
 */

/** 可信 usage（上游回执，未估算） */
export interface TrustedUsage {
  estimated: false;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** 缓存写入 token（Anthropic cache_creation 归一；写价≠输入价，必须透传） */
  cacheWriteTokens?: number;
}

/** 估算 usage（缺回执；input/output 均走估算口径，缓存命中不得估 0 扣费） */
export interface EstimatedUsage {
  estimated: true;
  inputTokens: number;
  outputTokens: number;
}

export type ReceiptUsage = TrustedUsage | EstimatedUsage;

/** 收据落账的 usage 快照形态（估算分支的 cachedInputTokens 恒 0——估算不认缓存命中） */
export type ReceiptUsageSnapshot = (
  | TrustedUsage
  | (EstimatedUsage & { cachedInputTokens: number })
) & {
  units?: number;
};

export interface UsageReceipt {
  requestId: string;
  userId: number;
  apiKeyId: number | null;
  appId: number | null;
  credentialType: 'key' | 'jwt';
  externalModel: string;
  realModel: string;
  channelId: number | null;
  channelKey: string;
  usage: ReceiptUsageSnapshot;
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  cacheWritePrice: string;
  unitPrice: string;
  coefficient: string;
  durationMs: number;
  stream: boolean;
  streamAborted: boolean;
  mappingId: number;
  billingPolicyFingerprint: string | null;
  /** 命中时段标签（schedule 策略审计列；缺省 = 无时段策略/未命中窗口） */
  pricingWindow?: string;
  /** 估算结算归属（usage.estimated=true 时必填且属白名单） */
  estimatedFor?: EstimateAttribution;
  /** 触发估算的透传字节数（校准作业与审计数据源；非流式恒 0） */
  bytesRelayed?: number;
  /** 首字延迟观测（流式专属；上游锚点=本次渠道发起，客户端锚点=请求进入） */
  upstreamTtftMs?: number;
  clientTtftMs?: number;
}

export interface ReceiptParams {
  requestId: string;
  auth: RequestAuth;
  /** 命中候选（价格快照来源；fallback 命中即 fallback 价） */
  candidate: QuoteCandidate;
  /** 请求的对外模型名（客户端所请求名；fallback 命中时 ≠ 候选自身对外名） */
  externalModel: string;
  channelId: number | null;
  channelKey: string;
  durationMs: number;
  /** 原始请求体——计量描述符的参数源（audioSeconds / n / input） */
  body: Record<string, unknown>;
  /** 上游响应体——计量描述符的实值源（images 的 data.length）；估算分支可缺 */
  responseBody?: unknown;
  usage: ReceiptUsage;
}

export function buildReceipt(params: ReceiptParams): UsageReceipt {
  const { candidate } = params;
  const units = measurementOf(candidate.pricingUnit ?? 'token').unitsOf(
    params.body,
    params.responseBody,
  );
  const { usage } = params;
  const usageSnapshot: ReceiptUsageSnapshot = usage.estimated
    ? {
        estimated: true,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: 0,
        ...(units > 0 ? { units } : {}),
      }
    : {
        estimated: false,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        ...((usage.cacheWriteTokens ?? 0) > 0 ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
        ...(units > 0 ? { units } : {}),
      };
  return {
    requestId: params.requestId,
    userId: params.auth.userId,
    apiKeyId: params.auth.apiKeyId,
    appId: params.auth.appId,
    credentialType: params.auth.appId != null ? 'jwt' : 'key',
    externalModel: params.externalModel,
    realModel: candidate.realModel,
    channelId: params.channelId,
    channelKey: params.channelKey,
    usage: usageSnapshot,
    inputPrice: candidate.inputPrice,
    outputPrice: candidate.outputPrice,
    cacheInputPrice: candidate.cacheInputPrice,
    cacheWritePrice: candidate.cacheWritePrice ?? '0',
    unitPrice: candidate.unitPrice ?? '0',
    coefficient: candidate.coefficient,
    durationMs: params.durationMs,
    stream: false,
    streamAborted: false,
    mappingId: candidate.mappingId,
    billingPolicyFingerprint: candidate.billingPolicyFingerprint,
    ...(candidate.pricingWindow != null ? { pricingWindow: candidate.pricingWindow } : {}),
    ...(usage.estimated ? { estimatedFor: 'usage_missing_nonstream' } : {}),
    ...(usage.estimated ? { bytesRelayed: 0 } : {}),
  };
}
