import type { TerminationReason, TextTokenFeatures, Usage } from '@tokenlens/ai';
import type { EstimateWeights } from './estimate';
import { estimateTokensFromFeatures, estimateTokensFromText } from './estimate';
import { streamEstimateAttribution, type EstimateAttribution } from './attribution';
import type { ReceiptUsage } from './receipt';

/**
 * 上游 usage → 收据 usage 的信任政策（v1 streamReceiptUsage / attempt-nonstream 的
 * 估算分支迁移，估算源按 C1/C6 演进）：
 *   - 可信 usage（未估算）→ 直通（cacheWrite>0 必须透传——写价≠输入价，丢弃即错账）；
 *   - ai 估算 usage（estimated，模型感知特征/BPE）→ 采纳其数值，仍标估算收据；
 *   - 完全缺失 → 本包口径兜底：input = 预检特征估算，output 按响应/输出特征估算。
 */

/** 非流式：ChatResult.usage → 收据 usage（估算输出从响应体文本估） */
export function usageForNonStream(
  usage: Usage | undefined,
  responseBody: unknown,
  fallbackInputTokens: number,
  weights: EstimateWeights,
): ReceiptUsage {
  if (usage != null && !usage.estimated) return trustedOf(usage);
  if (usage != null) {
    return { estimated: true, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
  }
  let outputTokens = 0;
  try {
    outputTokens = estimateTokensFromText(JSON.stringify(responseBody ?? '') ?? '', weights);
  } catch {
    outputTokens = 0;
  }
  return { estimated: true, inputTokens: fallbackInputTokens, outputTokens };
}

/** 流式终态事实（端口 success 事件的可信子集） */
export interface StreamTerminalFacts {
  usage?: Usage;
  terminated?: TerminationReason;
  bytesRelayed?: number;
  outputFeatures?: TextTokenFeatures;
}

export interface StreamUsageVerdict {
  usage: ReceiptUsage;
  /** 估算收据必带归属（billing 验收白名单） */
  estimatedFor?: EstimateAttribution;
  bytesRelayed?: number;
  /** 流式中断标记（中断 + 可信累计 usage → 正常结算，不标中断——v1 政策） */
  streamAborted: boolean;
}

/** 流式：终态 success → 收据 usage（缺 usage 输出按 outputFeatures 估算，C6） */
export function usageForStream(
  facts: StreamTerminalFacts,
  fallbackInputTokens: number,
  weights: EstimateWeights,
): StreamUsageVerdict {
  const usage = facts.usage;
  if (usage != null && !usage.estimated) {
    // 口径裁决（MIGRATION.md §3a R2）：可信累计 usage 优先，不标 stream_aborted——
    // ai events.ts 头注「success.terminated → 网关标 stream_aborted」是 v1 早期口径，
    // 与本实现相抵时以 inference 实现为准（中断但有可信 usage = 按最新 usage 正常结算）。
    return { usage: trustedOf(usage), streamAborted: false };
  }
  return {
    usage: {
      estimated: true,
      // input 实扣用最佳可得估算（ai 估算值优先，缺则预检口径）；字节上界不入实扣
      inputTokens: usage?.inputTokens ?? fallbackInputTokens,
      outputTokens:
        facts.outputFeatures != null
          ? estimateTokensFromFeatures(facts.outputFeatures, weights)
          : 0,
    },
    // 归属细分单一真相：用户取消 / 完成缺 usage / 上游故障 / 闲置超时 / 网关停机
    estimatedFor: streamEstimateAttribution(facts.terminated),
    bytesRelayed: facts.bytesRelayed ?? 0,
    streamAborted: facts.terminated != null,
  };
}

function trustedOf(usage: Usage): ReceiptUsage {
  return {
    estimated: false,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    ...((usage.cacheWriteTokens ?? 0) > 0 ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
  };
}
