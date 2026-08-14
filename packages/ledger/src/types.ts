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
  /** 最终成功的渠道名（链路 channel.final 与渠道拓扑同源命名） */
  channelKey: string;
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
  /** 本次结算是否触发了渠道「进货额度」熔断（软闸：status=3）。调用方据此清路由缓存。 */
  channelCircuitBroken?: boolean;
}

export interface BillingEffects {
  balanceChanged?(event: { userId: number; balanceAfter?: string }): Promise<void>;
  usageSettled?(event: { data: UsageReceipt; result: SettleResult }): Promise<void>;
  /** 请求转 dead（进入人工复核）：产生即告警——不变量被打破是缺陷信号，不允许静默积压 */
  requestDead?(event: {
    requestId: string;
    userId: number;
    failureClass: SettlementFailureClass;
    lastError: string;
    reservedAmount: string;
    attempt: number;
  }): Promise<void>;
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
  /** 发起凭证的 Key（JWT/无 Key 为 null）。用于 Key 级每日花费上限与订阅绑定。 */
  apiKeyId?: number | null;
  /** 发起凭证的 App（JWT 场景；Key/无凭证为 null）。用于 App 订阅绑定。 */
  appId?: number | null;
  stream: boolean;
  quote: BillingQuote;
  reservationLimit: string;
  authorizationTtlMs: number;
  /** 根 span 的 traceparent（00-{traceId}-{spanId}-01）；worker 结算时据此挂回同一 trace。 */
  traceParent?: string | null;
}

/** 渠道「进货额度」精确硬闸：路由选渠前为本次上游成本预估预留在途敞口。 */
export interface ReserveChannelCommand {
  requestId: string;
  /** 目标渠道（同一请求 fallback 换渠道时，旧渠道敞口在本次事务内原子释放） */
  channelId: number;
  /** 本次上游成本预估（元，官方价×上界，系数=1） */
  amount: string;
}

export interface ChannelReservationResult {
  allowed: boolean;
  /** 拒绝时的剩余可用额度（元，string）；放行时为本渠道本次预留后剩余 */
  remaining: string;
  /** 是否为本请求切换了渠道（释放了旧渠道敞口） */
  switched: boolean;
}

export interface BillingAuthorization {
  requestId: string;
  /** 本次预估敞口（元），非冻结金额；仅用于并发熔断，结算按实际金额扣费。 */
  reservedAmount: string;
  /** 已结算余额（信用模型下可为负，≥ -credit_limit）。 */
  settledBalance: string;
  /** 在途敞口总额（所有未终结请求预估之和）。 */
  reservedBalance: string;
  /** 可用信用 = settledBalance + creditLimit - reservedBalance。 */
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
  /** 授权时落列的根 traceparent；worker 以远端父创建 billing.settle span。 */
  traceParent: string | null;
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
  /**
   * 结算遥测钩子（worker 注入：以远端父创建 billing.settle span）。
   * 包裹 settleClaim：可观测结算耗时/结果，不改变结算语义。
   */
  telemetry?: {
    settle?(
      claim: SettlementClaim,
      next: () => Promise<SettleClaimResult>,
    ): Promise<SettleClaimResult>;
  };
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
