import type { QuoteCandidate } from '../domain/model/types';
import type { UsageReceipt } from '../domain/usage/receipt';

/**
 * billing port（跨能力经消费方 port——重构方案 §5.2；billing 建包前由装配注入实现）。
 * 金额运算（计价/预留/敞口）全部在 billing 侧：inference 只供候选价格快照与估算基础
 * 事实。业务拒绝（余额/限额/配置）由实现抛 billing 目录的 BusinessError 上抛。
 */
export interface BillingPort {
  /**
   * 请求级资金预扣（wallet hold + billing_requests 幂等行；requestId 幂等键）。
   * 敞口基础：候选链最贵者计（billing 语义）——inputTokenUpperBound 为保守上界，
   * maxOutputTokens 为输出上界口径。
   */
  authorize(input: {
    requestId: string;
    userId: number;
    apiKeyId: number | null;
    appId: number | null;
    stream: boolean;
    candidates: readonly QuoteCandidate[];
    inputTokenUpperBound: number;
    maxOutputTokens: number;
    authorizationTtlMs: number;
  }): Promise<void>;

  /**
   * 渠道采购预算敞口预留（尝试前）：allowed=false = 该渠道预算耗尽（换渠）。
   * 金额由 billing 按候选价格快照与估算基础自算。
   */
  reserveChannel(input: {
    requestId: string;
    channelId: number;
    candidate: QuoteCandidate;
    estimatedInputTokens: number;
    maxOutputTokens: number;
  }): Promise<{ allowed: true } | { allowed: false }>;

  /** 请求生命周期信号（词表 C5；lease 语义归 billing 状态机） */
  signal(input: BillingSignal): Promise<void>;
}

export type BillingSignal =
  | { type: 'upstream_started'; requestId: string; leaseOwner: string; leaseMs: number }
  | { type: 'lease_renewed'; requestId: string; leaseOwner: string; leaseMs: number }
  | { type: 'request_succeeded'; requestId: string; receipt: UsageReceipt }
  | { type: 'request_failed'; requestId: string; reason: string };
