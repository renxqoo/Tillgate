/**
 * 支付订单仓储：状态机 0 created → 1 paid → 2 credited 的两跳都是 CAS 单语句——
 * 回调可能重复到达、并发到达，只认第一次跃迁；入账金额在创建时定死（creditAmount），
 * 回调只认订单不重算。credited 跃迁不需要外部 operationId（入账幂等锚是
 * wallet 的 refType+refId），保留列仅作审计冗余。
 */
import { and, asc, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { DbTx } from '@ai-gateway/db';
import { users } from '@ai-gateway/db';
import { paymentOrders } from '@ai-gateway/db';
import type { RepoContext } from './context.js';

function tx(c: RepoContext): DbTx {
  return c.db as DbTx;
}

export interface PaymentOrderRow {
  id: string;
  provider: string;
  /** 渠道单号（列 notNull：先落库时以本单 orderId 占位——epay 即终值；Stripe 建会话后回填真实 session id） */
  providerOrderId: string;
  userId: number;
  amount: string;
  currency: string;
  creditAmount: string;
  status: number;
  createdAt: Date;
  paidAt: Date | null;
  creditedAt: Date | null;
}

export interface InsertPaymentOrderInput {
  id: string;
  provider: string;
  providerOrderId: string;
  userId: number;
  amount: string;
  currency: string;
  creditAmount: string;
  raw?: Record<string, unknown> | null;
}

/** 支付订单仓储（无状态；方法统一接收 RepoContext） */
export class PaymentOrderRepository {
  async insertOrder(c: RepoContext, input: InsertPaymentOrderInput): Promise<PaymentOrderRow> {
    const [row] = await tx(c)
      .insert(paymentOrders)
      .values({
        id: input.id,
        provider: input.provider,
        providerOrderId: input.providerOrderId,
        userId: input.userId,
        amount: input.amount,
        currency: input.currency,
        creditAmount: input.creditAmount,
        raw: input.raw ?? null,
      })
      .returning(this.projection);
    return row!;
  }

  /** 订单详情（属主域——前端支付后轮询用） */
  async findByUserAndId(
    c: RepoContext,
    input: { userId: number; orderId: string },
  ): Promise<PaymentOrderRow | null> {
    const [row] = await c.db
      .select(this.projection)
      .from(paymentOrders)
      .where(and(eq(paymentOrders.id, input.orderId), eq(paymentOrders.userId, input.userId)));
    return row ?? null;
  }

  /** 渠道会话建立后回填单号（回调定位锚） */
  async attachProviderOrderId(
    c: RepoContext,
    input: { orderId: string; providerOrderId: string },
  ): Promise<void> {
    await tx(c)
      .update(paymentOrders)
      .set({ providerOrderId: input.providerOrderId, updatedAt: sql`clock_timestamp()` })
      .where(and(eq(paymentOrders.id, input.orderId), eq(paymentOrders.status, 0)));
  }

  /** 渠道单号定位（回调路径；provider+providerOrderId 唯一） */
  async findByProviderOrderId(
    c: RepoContext,
    input: { provider: string; providerOrderId: string },
  ): Promise<PaymentOrderRow | null> {
    const [row] = await c.db
      .select(this.projection)
      .from(paymentOrders)
      .where(
        and(
          eq(paymentOrders.provider, input.provider),
          eq(paymentOrders.providerOrderId, input.providerOrderId),
        ),
      );
    return row ?? null;
  }

  async findById(c: RepoContext, orderId: string): Promise<PaymentOrderRow | null> {
    const [row] = await c.db
      .select(this.projection)
      .from(paymentOrders)
      .where(eq(paymentOrders.id, orderId));
    return row ?? null;
  }

  async listByUser(
    c: RepoContext,
    input: { userId: number; limit: number; offset: number },
  ): Promise<PaymentOrderRow[]> {
    return c.db
      .select(this.projection)
      .from(paymentOrders)
      .where(eq(paymentOrders.userId, input.userId))
      .orderBy(desc(paymentOrders.id))
      .limit(input.limit)
      .offset(input.offset);
  }

  /** 支付确认（CAS 0→1）：重复/乱序回调返回 null，由上层按现状态幂等处理 */
  async markPaid(
    c: RepoContext,
    input: { orderId: string; paidAt: Date },
  ): Promise<{ id: string; creditAmount: string; userId: number } | null> {
    const rows = await tx(c)
      .update(paymentOrders)
      .set({ status: 1, paidAt: input.paidAt, updatedAt: sql`clock_timestamp()` })
      .where(and(eq(paymentOrders.id, input.orderId), eq(paymentOrders.status, 0)))
      .returning({
        id: paymentOrders.id,
        creditAmount: paymentOrders.creditAmount,
        userId: paymentOrders.userId,
      });
    return rows[0] ?? null;
  }

  /** 入账完成（CAS 1→2）：入账事务的收尾；失败即回滚（订单停留 1 供重试） */
  async markCredited(
    c: RepoContext,
    input: { orderId: string; creditedAt: Date },
  ): Promise<boolean> {
    const rows = await tx(c)
      .update(paymentOrders)
      .set({ status: 2, creditedAt: input.creditedAt, updatedAt: sql`clock_timestamp()` })
      .where(and(eq(paymentOrders.id, input.orderId), eq(paymentOrders.status, 1)))
      .returning({ id: paymentOrders.id });
    return rows.length > 0;
  }

  /**
   * 超时关单（CAS 0→4，created 早于阈值）：列表读路径机会式清理。
   * 必须按用户域关单——全局关单会让任意用户的一次列表请求把别人正在支付中的
   * 订单置 4，随后渠道的成功回调被永久拒绝（用户已付、平台未入账的搁浅单）。
   */
  async expireOverdue(
    c: RepoContext,
    input: { userId: number; createdBefore: Date },
  ): Promise<number> {
    const result = await tx(c)
      .update(paymentOrders)
      .set({ status: 4, failureReason: 'expired', updatedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(paymentOrders.status, 0),
          eq(paymentOrders.userId, input.userId),
          lt(paymentOrders.createdAt, input.createdBefore),
        ),
      );
    return result.rowCount ?? 0;
  }

  /**
   * 过期单复活（CAS 4→1）：已验证签名且金额一致的渠道成功回调到达时——
   * 用户确实付了钱，「过期」只是我们侧的关单标记，不是资金事实。
   * 复活后由常规 paid→credited 收尾；并发回调输家重读按现状态幂等。
   */
  async reviveExpiredAsPaid(
    c: RepoContext,
    input: { orderId: string; paidAt: Date },
  ): Promise<{ id: string; creditAmount: string; userId: number } | null> {
    const rows = await tx(c)
      .update(paymentOrders)
      .set({ status: 1, paidAt: input.paidAt, failureReason: null, updatedAt: sql`clock_timestamp()` })
      .where(and(eq(paymentOrders.id, input.orderId), eq(paymentOrders.status, 4)))
      .returning({
        id: paymentOrders.id,
        creditAmount: paymentOrders.creditAmount,
        userId: paymentOrders.userId,
      });
    return rows[0] ?? null;
  }

  private readonly projection = {
    id: paymentOrders.id,
    provider: paymentOrders.provider,
    providerOrderId: paymentOrders.providerOrderId,
    userId: paymentOrders.userId,
    amount: paymentOrders.amount,
    currency: paymentOrders.currency,
    creditAmount: paymentOrders.creditAmount,
    status: paymentOrders.status,
    failureReason: paymentOrders.failureReason,
    createdAt: paymentOrders.createdAt,
    paidAt: paymentOrders.paidAt,
    creditedAt: paymentOrders.creditedAt,
  };

  // ── 管理面 ──────────────────────────────────────────────────────────────────

  /** 管理列表：q 为订单 uuid 精确命中，否则按用户显示名精确匹配 */
  async listAdminOrders(
    c: RepoContext,
    input: { q?: string; sortBy: 'createdAt' | 'amount' | 'status' | 'id'; order: 'asc' | 'desc'; limit: number; offset: number },
  ): Promise<{ rows: unknown[]; total: number }> {
    const where = input.q
      ? or(eq(paymentOrders.id, input.q), eq(users.displayName, input.q))
      : undefined;
    const sorts = { createdAt: paymentOrders.createdAt, amount: paymentOrders.amount, status: paymentOrders.status, id: paymentOrders.id } as const;
    const column = sorts[input.sortBy];
    const orderBy = [input.order === 'asc' ? asc(column) : desc(column), desc(paymentOrders.id)];
    const [rows, countRows] = await Promise.all([
      c.db
        .select({
          id: paymentOrders.id,
          provider: paymentOrders.provider,
          providerOrderId: paymentOrders.providerOrderId,
          userId: paymentOrders.userId,
          userDisplayName: users.displayName,
          userSubject: users.subject,
          amount: paymentOrders.amount,
          creditAmount: paymentOrders.creditAmount,
          currency: paymentOrders.currency,
          status: paymentOrders.status,
          failureReason: paymentOrders.failureReason,
          createdAt: paymentOrders.createdAt,
          paidAt: paymentOrders.paidAt,
          creditedAt: paymentOrders.creditedAt,
        })
        .from(paymentOrders)
        .leftJoin(users, eq(paymentOrders.userId, users.id))
        .where(where)
        .orderBy(...orderBy)
        .limit(input.limit)
        .offset(input.offset),
      c.db
        .select({ count: sql<number>`count(*)::int` })
        .from(paymentOrders)
        .leftJoin(users, eq(paymentOrders.userId, users.id))
        .where(where),
    ]);
    return { rows, total: countRows[0]?.count ?? 0 };
  }

  /** 手动关单：CAS status 0→4（created→expired 语义，failureReason 记管理员动作） */
  async closeOrder(c: RepoContext, input: { orderId: string; reason: string }): Promise<boolean> {
    const rows = await c.db
      .update(paymentOrders)
      .set({ status: 4, failureReason: input.reason, updatedAt: new Date() })
      .where(and(eq(paymentOrders.id, input.orderId), eq(paymentOrders.status, 0)))
      .returning({ id: paymentOrders.id });
    return rows.length > 0;
  }
}
