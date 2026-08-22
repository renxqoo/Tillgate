/**
 * 计费账单存储 port（billing_requests + billing_reservations + usage_logs 读侧——
 * billing 自有三表的聚合契约）。事务句柄复用钱包 port 的 WalletTx/WalletConn：
 * 同一 Db 上的两个 adapter 把同一底层 DbTx 铸成同形句柄——计费事务内可把句柄
 * 直接注入钱包动词（TxChannel），跨 store 编排单事务（DESIGN §2.1）。
 */
import type { WalletConn, WalletTx } from './wallet-store.js';

/** billing_requests 行形状（金额/状态原样 string；语义判定在 domain） */
export interface BillingRequestRow {
  requestId: string;
  userId: number;
  apiKeyId: number | null;
  appId?: number | null;
  channelId: number | null;
  channelReservedAmount: string | null;
  planReservedAmount: string | null;
  subscriptionId: number | null;
  estimatedExposureAmount: string | null;
  reservedAmount: string;
  status: string;
  revision: number;
  stream: boolean;
  quote: Record<string, unknown>;
  authorizationFingerprint: string;
  traceParent: string | null;
  receipt: Record<string, unknown> | null;
  receiptFingerprint: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  failureCode: string | null;
  settlementAttempts: number;
  nextSettlementAt: Date | null;
  claimOwner: string | null;
  claimToken: string | null;
  claimUntil: Date | null;
  createdAt: Date;
}

export interface BillingReservationRow {
  id: number;
  billingRequestId: string;
  sourceType: string;
  sourceRefId: number | null;
  amount: string;
  status: string;
}

export interface BillingStore {
  read<T>(fn: (conn: WalletConn) => Promise<T>): Promise<T>;
  transaction<T>(fn: (tx: WalletTx) => Promise<T>): Promise<T>;
  joinTransaction<T>(tx: WalletTx, fn: (tx: WalletTx) => Promise<T>): Promise<T>;

  findByRequestId(conn: WalletConn, requestId: string): Promise<BillingRequestRow | null>;
  /** 授权管线按 user 串行化的 advisory xact lock（SUM 口径限额在 READ COMMITTED 下防并发漏算） */
  advisoryLockAuthorizeUser(tx: WalletConn, userId: number): Promise<void>;
  /** requestId PK + onConflictDoNothing：false = 并发首请求已插入（重放兜底） */
  insertAuthorized(
    tx: WalletConn,
    input: {
      requestId: string;
      userId: number;
      apiKeyId: number | null;
      estimatedExposureAmount: string;
      reservedAmount: string;
      planReservedAmount: string | null;
      subscriptionId: number | null;
      stream: boolean;
      quote: Record<string, unknown>;
      authorizationFingerprint: string;
      traceParent: string | null;
      leaseExpiresAt: Date;
      nextSettlementAt: Date;
      createdAt: Date;
    },
  ): Promise<boolean>;
  /** 条件状态迁移（WHERE status IN from；命中则 set + revision+1）；命中 0 行 = 竞态输家 */
  casTransition(
    tx: WalletConn,
    input: {
      requestId: string;
      from: readonly string[];
      to: string;
      set?: {
        receipt?: Record<string, unknown>;
        receiptFingerprint?: string;
        leaseExpiresAt?: Date | null;
        leaseOwner?: string;
        nextSettlementAt?: Date | null;
        failureCode?: string;
        lastError?: string | null;
        releasedAt?: Date;
      };
    },
  ): Promise<boolean>;
  /** authorized|in_flight → in_flight 并起租约 */
  casUpstreamStarted(
    tx: WalletConn,
    input: { requestId: string; leaseOwner: string; leaseExpiresAt: Date },
  ): Promise<boolean>;
  /** 认领渠道投影（乐观锁：channel 投影必须等于读到的旧值） */
  casClaimChannel(
    tx: WalletConn,
    input: {
      requestId: string;
      fromStatus: readonly string[];
      expectedChannelId: number | null;
      expectedReserved: string | null;
      channelId: number;
      channelReservedAmount: string;
      now: Date;
    },
  ): Promise<boolean>;
  currentStatus(conn: WalletConn, requestId: string): Promise<string | null>;
  /** 在途敞口合计：sum(coalesce(estimated_exposure, reserved)) over 6 个在途态（可排除自身请求） */
  sumExposure(
    conn: WalletConn,
    input: {
      userId?: number;
      apiKeyId?: number;
      subscriptionId?: number;
      excludeRequestId?: string;
    },
  ): Promise<string>;
  /** 结算积压清单（准入闸输入） */
  inventory(
    conn: WalletConn,
    now: Date,
  ): Promise<{ pending: number; retrying: number; oldestPendingMs: number }>;
  /** 已结算花费合计（每日限额口径；usage_logs 投影） */
  sumSettledSpend(
    conn: WalletConn,
    input: { userId?: number; apiKeyId?: number; subscriptionId?: number; since: Date },
  ): Promise<string>;

  // ---- billing_reservations（资金瀑布真相表） ----
  insertReservation(
    tx: WalletConn,
    values: {
      billingRequestId: string;
      sourceType: string;
      sourceRefId: number | null;
      amount: string;
    },
  ): Promise<number>;
  /** 该请求全部 active 明细（账单状态 JOIN 过滤；statuses 可覆盖并入 released） */
  findActiveReservations(
    conn: WalletConn,
    billingRequestId: string,
    statuses?: readonly string[],
  ): Promise<BillingReservationRow[]>;
  markReservationReleased(tx: WalletConn, id: number, now: Date): Promise<boolean>;
  markReservationSettled(tx: WalletConn, id: number, now: Date): Promise<boolean>;

  // ---- 结算（U3：认领 / CAS 终态 / 恢复三路径 / usage 投影） ----
  /** 认领 pending/retry → processing（CTE + FOR UPDATE SKIP LOCKED；发 claim 三元组） */
  claimPending(
    tx: WalletConn,
    input: {
      ownerId: string;
      batchSize: number;
      claimLeaseMs: number;
      requestIds?: readonly string[];
    },
  ): Promise<
    Array<{
      requestId: string;
      claimToken: string;
      revision: number;
      attempt: number;
      receipt: Record<string, unknown> | null;
      traceParent: string | null;
    }>
  >;
  /** 认领租约保活（长结算事务防 recover 误回收 → 双扣防线） */
  renewClaims(
    tx: WalletConn,
    input: { ownerId: string; tokens: readonly string[]; claimLeaseMs: number },
  ): Promise<void>;
  /** 结算复验：五元组（processing + owner + token + revision + 租约未过期）全匹配 */
  findProcessingForClaim(
    tx: WalletConn,
    claim: { requestId: string; ownerId: string; claimToken: string; revision: number },
  ): Promise<BillingRequestRow | null>;
  /** CAS processing → settled（五元组；清认领） */
  casFinalizeSettled(
    tx: WalletConn,
    claim: { requestId: string; ownerId: string; claimToken: string; revision: number },
  ): Promise<boolean>;
  /** 失败处置 CAS：processing → retry_wait（退避）/ dead（死信） */
  casToRetryOrDead(
    tx: WalletConn,
    claim: { requestId: string; ownerId: string; claimToken: string; revision: number },
    input: { dead: boolean; nextDelayMs: number | null; failureClass: string; lastError: string },
  ): Promise<boolean>;
  /** 恢复①②候选清单（无锁列出；逐单 CAS 隔毒行） */
  listExpiredForRecovery(
    conn: WalletConn,
    input: { status: 'authorized' | 'in_flight'; limit: number },
  ): Promise<string[]>;
  /** 逐单 CAS → released（authorized 守卫未发上游；in_flight 守卫租约过期） */
  recoverOneToReleased(
    tx: WalletConn,
    input: { requestId: string; status: 'authorized' | 'in_flight'; failureCode: string },
  ): Promise<{
    requestId: string;
    reservedAmount: string;
    channelId: number | null;
    channelReservedAmount: string | null;
  } | null>;
  /** 恢复③：processing 认领租约过期 → retry_wait 立即可重领 */
  requeueExpiredClaims(tx: WalletConn, limit: number): Promise<number>;
  /** 优雅停机：本副本持有的 processing 归还 retry_wait */
  abandonOwnedClaims(tx: WalletConn, ownerId: string, now: Date): Promise<number>;
  /** usage_logs 投影落库（requestId 唯一约束幂等；false = 已存在） */
  insertUsageLog(tx: WalletConn, values: Record<string, unknown>): Promise<boolean>;
  /** 结算幂等回查：usage_logs 已有金额（认领失效时判 already_settled） */
  findUsageAmount(conn: WalletConn, requestId: string): Promise<string | null>;

  isUniqueViolation(error: unknown): boolean;
}
