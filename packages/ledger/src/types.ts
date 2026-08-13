/**
 * 计量 job 数据（gateway 生产、worker 消费，全链路唯一类型定义）。
 * 价格/系数用元 + 小数（无整数编码），amount/upstreamCost 全程 Decimal 账本永不 round。
 */
export interface UsageReceipt {
  /** 幂等键（= billing_requests.request_id = usage_logs.request_id 唯一约束） */
  requestId: string;
  userId: number;
  apiKeyId: number | null;
  appId: number | null;
  /** key / jwt */
  credentialType: string;
  /** 对外模型名（用户请求的） */
  externalModel: string;
  /** 实际模型名（上游真实模型，可能经 fallback 切换） */
  realModel: string;
  /** 最终成功的渠道 ID（候选循环选中的） */
  channelId: number | null;
  /** usage（ai 包归一化后的 token 数） */
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    estimated: boolean;
  };
  /** 价格快照（元/百万 token，来自实际成功模型 model_mappings numeric 列） */
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  /** 费率卡系数（小数，如 1.0） */
  coefficient: string;
  /** 请求耗时 ms */
  durationMs: number;
  /** 是否流式 */
  stream: boolean;
  /** 流式是否中断（terminated） */
  streamAborted: boolean;
  /** 模型映射 ID（模型级 TPM 回填维度用，= 实际成功模型） */
  mappingId: number;
  /** 必须与授权候选的多模态策略快照一致；纯文本为 null。 */
  billingPolicyFingerprint: string | null;
}

export interface SettleResult {
  /** 是否本次执行了结算（false = 幂等跳过，已结算过） */
  settled: boolean;
  /** 实际扣费金额（元，string） */
  amount: string;
  /** 按供应商可信 usage 精确计算的费用。 */
  calculatedAmount: string;
}

export interface BillingEffects {
  balanceChanged?(event: { userId: number; balanceAfter?: string }): Promise<void>;
  usageSettled?(event: { data: UsageReceipt; result: SettleResult }): Promise<void>;
}

export interface BillingQuoteCandidate {
  mappingId: number;
  externalModel: string;
  realModel: string;
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  coefficient: string;
  /** 本候选请求输入 token 的可证明上界（文本字节或模型多模态硬上限）。 */
  inputTokenUpperBound: number;
  /** 多模态策略快照指纹；纯文本为 null。 */
  billingPolicyFingerprint: string | null;
}

/** 已按供应商参数规则归一化后的可信报价输入。 */
export interface BillingQuote {
  /** 已包含 n 等倍数后的最大输出 token 总量。 */
  maxOutputTokens: number;
  candidates: BillingQuoteCandidate[];
  /** 只有显式免费策略才能产生 0 元授权。 */
  explicitlyFree?: boolean;
}

export interface AuthorizeBillingCommand {
  requestId: string;
  userId: number;
  stream: boolean;
  quote: BillingQuote;
  reservationLimit: string;
  authorizationTtlMs: number;
}

export interface BillingAuthorization {
  requestId: string;
  reservedAmount: string;
  /** 授权不会改变已结算余额。 */
  settledBalance: string;
  /** 授权完成后的处理中预留总额。 */
  reservedBalance: string;
  /** settledBalance - reservedBalance。 */
  availableBalance: string;
  replayed: boolean;
}

export type BillingEvent =
  | {
      type: 'upstream.started';
      requestId: string;
      leaseOwner: string;
      leaseMs: number;
    }
  | {
      type: 'lease.renewed';
      requestId: string;
      leaseOwner: string;
      leaseMs: number;
    }
  | {
      type: 'request.succeeded';
      requestId: string;
      receipt: UsageReceipt;
    }
  | {
      /** 已经触达上游或客户端，但缺少可信 usage/收费终态；保留预扣等待审计。 */
      type: 'request.uncertain';
      requestId: string;
      reason: string;
    }
  | {
      type: 'request.failed';
      requestId: string;
      reason: string;
      delivery: 'none';
      upstreamCharge: 'none' | 'unknown';
    };

export interface BillingSignalResult {
  changed: boolean;
  status: string;
  replayed: boolean;
}

export type BillingRequestStatus =
  | 'authorized'
  | 'in_flight'
  | 'settlement_pending'
  | 'processing'
  | 'retry_wait'
  | 'settled'
  | 'released'
  | 'uncertain'
  | 'dead';

export type SettlementFailureClass =
  | 'db_transient'
  | 'serialization'
  | 'dependency_transient'
  | 'poison_receipt'
  | 'invariant_violation'
  | 'missing_subject'
  | 'claim_expired'
  | 'unknown';

export interface SettlementClaim {
  requestId: string;
  ownerId: string;
  claimToken: string;
  revision: number;
  attempt: number;
  receipt: UsageReceipt;
  claimedAt: Date;
  claimUntil: Date;
}

export interface SettlementProcessorOptions {
  ownerId: string;
  batchSize: number;
  /** 单个 processor 同时持有/结算的最大 claim 数；不得靠 Bull 并发间接放大。 */
  concurrency?: number;
  claimLeaseMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  maxAttempts: number;
  recoveryBatchSize?: number;
}

export interface SettlementRunResult {
  claimed: number;
  settled: number;
  retried: number;
  dead: number;
  claimLost: number;
}

export interface SettleClaimResult extends SettleResult {
  outcome: 'settled' | 'already_settled' | 'claim_lost';
}

export interface RecoveryRunResult {
  released: number;
  uncertain: number;
  claimsRequeued: number;
}

export interface BillingInventory {
  pending: number;
  processing: number;
  retrying: number;
  dead: number;
  uncertain: number;
  oldestPendingMs: number;
}
