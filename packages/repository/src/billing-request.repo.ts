/**
 * billing_requests 仓储：8 态状态机的全部 SQL。
 * 状态机真相就在各 CAS 的 WHERE 里（与资金动作同事务）；意图化原子操作，
 * 守卫内联——并发迁移/双扣在结构上不可达。
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbTx } from '@ai-gateway/db';
import { billingRequests } from '@ai-gateway/db';
import type { RepoContext } from './context.js';

function tx(c: RepoContext): DbTx {
  return c.db as DbTx;
}

const EXPOSURE_STATUSES = sql`('authorized','in_flight','settlement_pending','processing','retry_wait','dead')`;

export interface NewBillingRequest {
  requestId: string;
  userId: number;
  apiKeyId: number | null;
  appId: number | null;
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
}

export interface BillingRow {
  requestId: string;
  userId: number;
  apiKeyId: number | null;
  reservedAmount: string;
  planReservedAmount: string | null;
  subscriptionId: number | null;
  channelId: number | null;
  channelReservedAmount: string | null;
  status: string;
  revision: number;
  quote: Record<string, unknown>;
  receipt: Record<string, unknown> | null;
  receiptFingerprint: string | null;
  authorizationFingerprint: string;
  leaseOwner: string | null;
  claimOwner: string | null;
}

export interface TransitionResult {
  changed: boolean;
  status: string;
}

export interface ClaimedBillingRow {
  request_id: string;
  claim_token: string;
  revision: number;
  settlement_attempts: number;
  receipt: Record<string, unknown> | null;
  trace_parent: string | null;
  [key: string]: unknown;
}

export interface RecoverReleaseRow {
  request_id: string;
  user_id: number;
  reserved_amount: string;
  plan_reserved_amount: string | null;
  subscription_id: number | null;
  channel_id: number | null;
  channel_reserved_amount: string | null;
  [key: string]: unknown;
}

export interface BillingInventory {
  pending: number;
  processing: number;
  retrying: number;
  dead: number;
  oldestPendingMs: number;
}

export interface DeadCaseRow {
  requestId: string;
  userId: number;
  revision: number;
  reservedAmount: string;
  failureCode: string | null;
  failureClass: string | null;
  lastError: string | null;
}

/** billing_requests 状态机仓储（无状态；方法统一接收 RepoContext——事务由用例层注入） */
export class BillingRequestRepository {
  /** 授权串行化锁：SUM 口径限额在 READ COMMITTED 下看不见并发未提交行——按 user 定序 */
  async advisoryLockAuthorizeUser(c: RepoContext, userId: number): Promise<void> {
    await tx(c).execute(
      sql`select pg_advisory_xact_lock(hashtext('billing.authorize.user:' || ${userId}::text))`,
    );
  }

  /** 落账（requestId 幂等）：false=已存在（重放比对走 findByRequestId） */
  async insertAuthorized(c: RepoContext, values: NewBillingRequest): Promise<boolean> {
    const rows = await tx(c)
      .insert(billingRequests)
      .values({ ...values, status: 'authorized', updatedAt: values.createdAt })
      .onConflictDoNothing({ target: billingRequests.requestId })
      .returning({ id: billingRequests.requestId });
    return rows.length > 0;
  }

  async findByRequestId(c: RepoContext, requestId: string): Promise<BillingRow | null> {
    const [row] = await c.db
      .select({
        requestId: billingRequests.requestId,
        userId: billingRequests.userId,
        apiKeyId: billingRequests.apiKeyId,
        reservedAmount: billingRequests.reservedAmount,
        planReservedAmount: billingRequests.planReservedAmount,
        subscriptionId: billingRequests.subscriptionId,
        channelId: billingRequests.channelId,
        channelReservedAmount: billingRequests.channelReservedAmount,
        status: billingRequests.status,
        revision: billingRequests.revision,
        quote: billingRequests.quote,
        receipt: billingRequests.receipt,
        receiptFingerprint: billingRequests.receiptFingerprint,
        authorizationFingerprint: billingRequests.authorizationFingerprint,
        leaseOwner: billingRequests.leaseOwner,
        claimOwner: billingRequests.claimOwner,
      })
      .from(billingRequests)
      .where(eq(billingRequests.requestId, requestId));
    return (row as BillingRow) ?? null;
  }

  // ---------- signal 事件（CAS 状态迁移） ----------

  /** 条件状态迁移（from 集合 → to + 附加列）；0 行 = 未命中（重放/冲突由调用方分岔） */
  async casTransition(
    c: RepoContext,
    input: { requestId: string; from: readonly string[]; to: string; set?: Record<string, unknown> },
  ): Promise<TransitionResult> {
    const rows = await tx(c)
      .update(billingRequests)
      .set({
        status: input.to,
        revision: sql`${billingRequests.revision} + 1`,
        ...(input.set as object),
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(billingRequests.requestId, input.requestId),
          inArray(billingRequests.status, [...input.from]),
        ),
      )
      .returning({ status: billingRequests.status });
    const row = rows[0];
    return row ? { changed: true, status: row.status } : { changed: false, status: '' };
  }

  async currentStatus(c: RepoContext, requestId: string): Promise<string | null> {
    const [row] = await c.db
      .select({ status: billingRequests.status })
      .from(billingRequests)
      .where(eq(billingRequests.requestId, requestId));
    return row?.status ?? null;
  }

  /** upstream.started 专用迁移：coalesce 保首次 upstream_started_at；authorized|in_flight → in_flight */
  async casUpstreamStarted(
    c: RepoContext,
    input: { requestId: string; leaseOwner: string; leaseExpiresAt: Date },
  ): Promise<boolean> {
    const rows = await tx(c)
      .update(billingRequests)
      .set({
        status: 'in_flight',
        revision: sql`${billingRequests.revision} + 1`,
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: input.leaseExpiresAt,
        upstreamStartedAt: sql`coalesce(${billingRequests.upstreamStartedAt}, clock_timestamp())`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(billingRequests.requestId, input.requestId),
          inArray(billingRequests.status, ['authorized', 'in_flight']),
        ),
      )
      .returning({ id: billingRequests.requestId });
    return rows.length > 0;
  }

  // ---------- 渠道敞口认领（reserveChannel 用） ----------

  /**
   * 渠道投影 CAS：channelId/channelReservedAmount 等于读到的旧值才更新
   * （并发同请求换渠道的输家在此落空并整体回滚，敞口不孤儿化）。
   */
  async casClaimChannel(
    c: RepoContext,
    input: {
      requestId: string;
      fromStatus: readonly string[];
      expectedChannelId: number | null;
      expectedReserved: string | null;
      channelId: number;
      channelReservedAmount: string;
      now: Date;
    },
  ): Promise<boolean> {
    const rows = await tx(c)
      .update(billingRequests)
      .set({
        channelId: input.channelId,
        channelReservedAmount: input.channelReservedAmount,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(billingRequests.requestId, input.requestId),
          inArray(billingRequests.status, [...input.fromStatus]),
          input.expectedChannelId == null
            ? sql`${billingRequests.channelId} is null`
            : eq(billingRequests.channelId, input.expectedChannelId),
          input.expectedReserved == null
            ? sql`${billingRequests.channelReservedAmount} is null`
            : eq(billingRequests.channelReservedAmount, input.expectedReserved),
        ),
      )
      .returning({ id: billingRequests.requestId });
    return rows.length > 0;
  }

  // ---------- 结算认领与 CAS（SKIP LOCKED / 五元组） ----------

  /** 批量认领：settlement_pending/retry_wait → processing（claim 三元组 + revision 乐观锁） */
  async claimPending(
    c: RepoContext,
    input: { ownerId: string; limit: number; claimLeaseMs: number; requestIds?: readonly string[] },
  ): Promise<ClaimedBillingRow[]> {
    const idFilter =
      input.requestIds && input.requestIds.length > 0
        ? sql`and request_id in (${sql.join(
            input.requestIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`
        : sql``;
    const result = await tx(c).execute<ClaimedBillingRow>(sql`
      with candidates as (
        select request_id from billing_requests
        where status in ('settlement_pending', 'retry_wait')
          and (next_settlement_at is null or next_settlement_at <= clock_timestamp())
          ${idFilter}
        order by next_settlement_at nulls first, created_at
        for update skip locked
        limit ${input.limit}
      )
      update billing_requests b
      set status = 'processing',
          revision = b.revision + 1,
          settlement_attempts = b.settlement_attempts + 1,
          claim_owner = ${input.ownerId},
          claim_token = gen_random_uuid(),
          claim_until = clock_timestamp() + (${input.claimLeaseMs} * interval '1 millisecond'),
          failure_class = null,
          last_error = null,
          updated_at = clock_timestamp()
      from candidates c2
      where b.request_id = c2.request_id
      returning b.request_id, b.claim_token, b.revision, b.settlement_attempts,
                b.receipt, b.trace_parent
    `);
    return result.rows;
  }

  /** 认领租约保活（结算长事务防 recover 误判回收 → 双扣防线） */
  async renewClaims(
    c: RepoContext,
    input: { ownerId: string; tokens: readonly string[]; claimLeaseMs: number },
  ): Promise<void> {
    if (input.tokens.length === 0) return;
    await tx(c).execute(sql`
      update billing_requests
      set claim_until = clock_timestamp() + (${input.claimLeaseMs} * interval '1 millisecond'),
          updated_at = clock_timestamp()
      where status = 'processing'
        and claim_owner = ${input.ownerId}
        and claim_token in (${sql.join(
          input.tokens.map((token) => sql`${token}::uuid`),
          sql`, `,
        )})
        and claim_until > clock_timestamp()
    `);
  }

  /** 结算收尾 CAS：五元组（status/owner/token/revision/claimUntil）命中才置 settled */
  async casFinalizeSettled(
    c: RepoContext,
    claim: { requestId: string; claimToken: string; ownerId: string; revision: number },
  ): Promise<boolean> {
    const rows = await tx(c)
      .update(billingRequests)
      .set({
        status: 'settled',
        revision: sql`${billingRequests.revision} + 1`,
        claimOwner: null,
        claimToken: null,
        claimUntil: null,
        settledAt: sql`clock_timestamp()`,
        nextSettlementAt: null,
        lastError: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(billingRequests.requestId, claim.requestId),
          eq(billingRequests.status, 'processing'),
          eq(billingRequests.claimToken, claim.claimToken),
          eq(billingRequests.claimOwner, claim.ownerId),
          eq(billingRequests.revision, claim.revision),
          sql`${billingRequests.claimUntil} > clock_timestamp()`,
        ),
      )
      .returning({ id: billingRequests.requestId });
    return rows.length > 0;
  }

  /** 失败处置 CAS：processing → retry_wait / dead（退避或立即死信） */
  async casToRetryOrDead(
    c: RepoContext,
    claim: { requestId: string; claimToken: string; ownerId: string; revision: number },
    input: { dead: boolean; nextDelayMs: number | null; failureClass: string; lastError: string },
  ): Promise<boolean> {
    const rows = await tx(c)
      .update(billingRequests)
      .set({
        status: input.dead ? 'dead' : 'retry_wait',
        revision: sql`${billingRequests.revision} + 1`,
        nextSettlementAt: input.dead
          ? null
          : sql`clock_timestamp() + (${input.nextDelayMs} * interval '1 millisecond')`,
        claimOwner: null,
        claimToken: null,
        claimUntil: null,
        failureClass: input.failureClass,
        lastError: input.lastError.slice(0, 4000),
        deadAt: input.dead ? sql`clock_timestamp()` : null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(billingRequests.requestId, claim.requestId),
          eq(billingRequests.status, 'processing'),
          eq(billingRequests.claimToken, claim.claimToken),
          eq(billingRequests.claimOwner, claim.ownerId),
          eq(billingRequests.revision, claim.revision),
          sql`${billingRequests.claimUntil} > clock_timestamp()`,
        ),
      )
      .returning({ id: billingRequests.requestId });
    return rows.length > 0;
  }

  /**
   * 结算复验：五元组（status=processing + claimOwner + claimToken + revision + 租约未过期）
   * 全匹配才返回投影——认领与读在一次 WHERE 定序。
   */
  async findProcessingForClaim(
    c: RepoContext,
    claim: { requestId: string; ownerId: string; claimToken: string; revision: number },
  ): Promise<BillingRow | null> {
    const [row] = await tx(c)
      .select({
        requestId: billingRequests.requestId,
        userId: billingRequests.userId,
        apiKeyId: billingRequests.apiKeyId,
        reservedAmount: billingRequests.reservedAmount,
        planReservedAmount: billingRequests.planReservedAmount,
        subscriptionId: billingRequests.subscriptionId,
        channelId: billingRequests.channelId,
        channelReservedAmount: billingRequests.channelReservedAmount,
        status: billingRequests.status,
        revision: billingRequests.revision,
        quote: billingRequests.quote,
        receipt: billingRequests.receipt,
        receiptFingerprint: billingRequests.receiptFingerprint,
        authorizationFingerprint: billingRequests.authorizationFingerprint,
        leaseOwner: billingRequests.leaseOwner,
        claimOwner: billingRequests.claimOwner,
      })
      .from(billingRequests)
      .where(
        and(
          eq(billingRequests.requestId, claim.requestId),
          eq(billingRequests.status, 'processing'),
          eq(billingRequests.claimToken, claim.claimToken),
          eq(billingRequests.claimOwner, claim.ownerId),
          eq(billingRequests.revision, claim.revision),
          sql`${billingRequests.claimUntil} > clock_timestamp()`,
        ),
      );
    return (row as BillingRow) ?? null;
  }

  // ---------- 恢复三路径（SKIP LOCKED 批量） ----------

  /** ① authorized 过期且从未发上游 → released；② in_flight 租约过期（网关崩溃）→ released */
  async recoverExpiredToReleased(
    c: RepoContext,
    input: { status: 'authorized' | 'in_flight'; limit: number; failureCode: string },
  ): Promise<RecoverReleaseRow[]> {
    const upstreamGuard =
      input.status === 'authorized' ? sql`and upstream_started_at is null` : sql``;
    const result = await tx(c).execute<RecoverReleaseRow>(sql`
      with candidates as (
        select request_id from billing_requests
        where status = ${input.status}
          and lease_expires_at <= clock_timestamp()
          ${upstreamGuard}
        order by lease_expires_at
        for update skip locked
        limit ${input.limit}
      )
      update billing_requests b
      set status = 'released', revision = b.revision + 1,
        failure_code = ${input.failureCode},
        lease_expires_at = null, released_at = clock_timestamp(), updated_at = clock_timestamp()
      from candidates c2
      where b.request_id = c2.request_id and b.status = ${input.status}
        ${input.status === 'authorized' ? sql`and b.upstream_started_at is null` : sql``}
      returning b.request_id, b.user_id, b.reserved_amount, b.plan_reserved_amount,
                b.subscription_id, b.channel_id, b.channel_reserved_amount
    `);
    return result.rows;
  }

  /**
   * ①② 的逐单形态（recover 毒行隔离）：先无锁列出候选（逐单 CAS 重新校验状态与
   * 守卫，竞态安全），再逐单事务 CAS+归还——单行投影异常只阻塞自己，不阻塞整批
   * （批量单事务形态下毒行队头阻塞全部滞留单的资金归还）。
   */
  async listExpiredForRecovery(
    c: RepoContext,
    input: { status: 'authorized' | 'in_flight'; limit: number },
  ): Promise<string[]> {
    const upstreamGuard =
      input.status === 'authorized' ? sql`and upstream_started_at is null` : sql``;
    const result = await c.db.execute<{ request_id: string }>(sql`
      select request_id from billing_requests
      where status = ${input.status}
        and lease_expires_at <= clock_timestamp()
        ${upstreamGuard}
      order by lease_expires_at
      limit ${input.limit}
    `);
    return result.rows.map((row) => row.request_id);
  }

  /** 逐单 CAS 迁移 released（状态+守卫全复核；0 行 = 他方已处理或状态已变） */
  async recoverOneToReleased(
    c: RepoContext,
    input: { requestId: string; status: 'authorized' | 'in_flight'; failureCode: string },
  ): Promise<RecoverReleaseRow | null> {
    const upstreamGuard =
      input.status === 'authorized' ? sql`and upstream_started_at is null` : sql``;
    const leaseGuard =
      input.status === 'authorized'
        ? sql``
        : sql`and lease_expires_at <= clock_timestamp()`;
    const result = await tx(c).execute<RecoverReleaseRow>(sql`
      update billing_requests b
      set status = 'released', revision = b.revision + 1,
        failure_code = ${input.failureCode},
        lease_expires_at = null, released_at = clock_timestamp(), updated_at = clock_timestamp()
      where b.request_id = ${input.requestId} and b.status = ${input.status}
        ${upstreamGuard} ${leaseGuard}
      returning b.request_id, b.user_id, b.reserved_amount, b.plan_reserved_amount,
                b.subscription_id, b.channel_id, b.channel_reserved_amount
    `);
    return result.rows[0] ?? null;
  }

  /** ③ processing 认领租约过期（worker 崩溃）→ retry_wait 立即可重领 */
  async requeueExpiredClaims(c: RepoContext, limit: number): Promise<number> {
    const result = await tx(c).execute(sql`
      with candidates as (
        select request_id from billing_requests
        where status = 'processing' and claim_until <= clock_timestamp()
        order by claim_until for update skip locked limit ${limit}
      )
      update billing_requests b set
        status = 'retry_wait', revision = b.revision + 1,
        next_settlement_at = clock_timestamp(),
        claim_owner = null, claim_token = null, claim_until = null,
        failure_class = 'claim_expired', last_error = 'settlement claim lease expired',
        updated_at = clock_timestamp()
      from candidates c2 where b.request_id = c2.request_id and b.status = 'processing'
      returning b.request_id
    `);
    return result.rows.length;
  }

  /** 优雅停机：本副本持有的 processing 归还 retry_wait */
  async abandonOwnedClaims(c: RepoContext, ownerId: string, now: Date): Promise<number> {
    const rows = await tx(c)
      .update(billingRequests)
      .set({
        status: 'retry_wait',
        revision: sql`${billingRequests.revision} + 1`,
        nextSettlementAt: now,
        claimOwner: null,
        claimToken: null,
        claimUntil: null,
        failureClass: 'claim_expired',
        lastError: 'worker shutdown returned claim',
        updatedAt: now,
      })
      .where(and(eq(billingRequests.status, 'processing'), eq(billingRequests.claimOwner, ownerId)))
      .returning({ id: billingRequests.requestId });
    return rows.length;
  }

  // ---------- 限额读模型（在途敞口 SUM；已结算侧在 UsageLogRepository） ----------

  /** 在途敞口：未终结 billing_requests 的 reserved_amount 之和（不按时间过滤——跨窗口对称性） */
  async sumExposure(
    c: RepoContext,
    dims: {
      userId?: number;
      apiKeyId?: number;
      subscriptionId?: number;
      /** 排除自身请求（幂等重放时口径不得把本请求算两遍） */
      excludeRequestId?: string;
    },
  ): Promise<string> {
    const conditions = [sql`status in ${EXPOSURE_STATUSES}`];
    if (dims.userId != null) conditions.push(sql`user_id = ${dims.userId}`);
    if (dims.apiKeyId != null) conditions.push(sql`api_key_id = ${dims.apiKeyId}`);
    if (dims.subscriptionId != null) conditions.push(sql`subscription_id = ${dims.subscriptionId}`);
    if (dims.excludeRequestId != null) {
      conditions.push(sql`request_id <> ${dims.excludeRequestId}`);
    }
    const result = await c.db.execute<{ total: string }>(sql`
      select coalesce(sum(reserved_amount), 0)::text as total from billing_requests
      where ${sql.join(conditions, sql` and `)}
    `);
    return result.rows[0]?.total ?? '0';
  }

  // ---------- 库存 ----------

  async inventory(c: RepoContext, now: Date): Promise<BillingInventory> {
    const result = await c.db.execute<{
      pending: string;
      processing: string;
      retrying: string;
      dead: string;
      oldest: Date | string | null;
    }>(sql`
      select
        count(*) filter (where status = 'settlement_pending')::text as pending,
        count(*) filter (where status = 'processing')::text as processing,
        count(*) filter (where status = 'retry_wait')::text as retrying,
        count(*) filter (where status = 'dead')::text as dead,
        min(created_at) filter (where status in ('settlement_pending','processing','retry_wait')) as oldest
      from billing_requests
    `);
    const row = result.rows[0]!;
    const oldest = row.oldest ? new Date(row.oldest as string).getTime() : now.getTime();
    return {
      pending: Number(row.pending),
      processing: Number(row.processing),
      retrying: Number(row.retrying),
      dead: Number(row.dead),
      oldestPendingMs: Math.max(0, now.getTime() - oldest),
    };
  }

  // ---------- 死单复核 ----------

  async listDeadCases(c: RepoContext, limit: number, offset: number): Promise<DeadCaseRow[]> {
    const rows = await c.db
      .select({
        requestId: billingRequests.requestId,
        userId: billingRequests.userId,
        revision: billingRequests.revision,
        reservedAmount: billingRequests.reservedAmount,
        failureCode: billingRequests.failureCode,
        failureClass: billingRequests.failureClass,
        lastError: billingRequests.lastError,
      })
      .from(billingRequests)
      .where(eq(billingRequests.status, 'dead'))
      .orderBy(sql`${billingRequests.reservedAmount} desc`, sql`${billingRequests.updatedAt} desc`)
      .limit(limit)
      .offset(offset);
    return rows as DeadCaseRow[];
  }

  async countDead(c: RepoContext): Promise<number> {
    const [row] = await c.db
      .select({ count: sql<number>`count(*)::int` })
      .from(billingRequests)
      .where(eq(billingRequests.status, 'dead'));
    return Number(row?.count ?? 0);
  }

  /** retryDead：dead → retry_wait（期望版本 CAS；attempts 归零立即可重领） */
  async casRetryDead(
    c: RepoContext,
    input: { requestId: string; expectedRevision: number },
  ): Promise<boolean> {
    const rows = await tx(c)
      .update(billingRequests)
      .set({
        status: 'retry_wait',
        revision: sql`${billingRequests.revision} + 1`,
        settlementAttempts: 0,
        nextSettlementAt: sql`clock_timestamp()`,
        failureClass: null,
        lastError: null,
        deadAt: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(billingRequests.requestId, input.requestId),
          eq(billingRequests.status, 'dead'),
          eq(billingRequests.revision, input.expectedRevision),
        ),
      )
      .returning({ id: billingRequests.requestId });
    return rows.length > 0;
  }

  /** abandonDead：dead → released（期望版本 CAS）；返回三路释放投影 */
  async casAbandonDead(
    c: RepoContext,
    input: { requestId: string; expectedRevision: number; releasedAt: Date },
  ): Promise<RecoverReleaseRow | null> {
    const rows = await tx(c)
      .update(billingRequests)
      .set({
        status: 'released',
        revision: sql`${billingRequests.revision} + 1`,
        failureCode: 'manually_abandoned',
        releasedAt: input.releasedAt,
        deadAt: null,
        nextSettlementAt: null,
        claimOwner: null,
        claimToken: null,
        claimUntil: null,
        updatedAt: input.releasedAt,
      })
      .where(
        and(
          eq(billingRequests.requestId, input.requestId),
          eq(billingRequests.status, 'dead'),
          eq(billingRequests.revision, input.expectedRevision),
        ),
      )
      .returning({
        request_id: billingRequests.requestId,
        user_id: billingRequests.userId,
        reserved_amount: billingRequests.reservedAmount,
        plan_reserved_amount: billingRequests.planReservedAmount,
        subscription_id: billingRequests.subscriptionId,
        channel_id: billingRequests.channelId,
        channel_reserved_amount: billingRequests.channelReservedAmount,
      });
    return (rows[0] as RecoverReleaseRow) ?? null;
  }
}
