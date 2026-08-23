/**
 * 支付订单与兑换码的 PostgreSQL adapter（payment_orders / redeem_batches / redeem_codes）。
 * 语义基准：旧仓 payment-order.repo / redeem-{batch,code}.repo 活路径逐方法平移。
 * 状态机：payment_orders 0 created → 1 paid → 2 credited（4 expired 关单标记可复活）；
 * redeem_codes 0 未用 → 1 已核销 / 2 已吊销（库内只存 SHA-256，明文仅返回一次）。
 */
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import {
  paymentOrders,
  redeemBatches,
  redeemCodes,
  users,
  type Db,
  type DbTx,
} from '@tokenlens/db';
import type { WalletConn } from '../../ports/wallet-store.js';
import type {
  AdminPaymentOrderRow,
  RedeemBatchRecord,
  RedeemCodeRecord,
} from '../../ports/payment-ports.js';

/** LIKE 字面匹配转义（% _ \） */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (m) => `\\${m}`);
}

const BATCH_COLUMNS = {
  id: redeemBatches.id,
  name: redeemBatches.name,
  remark: redeemBatches.remark,
  amount: redeemBatches.amount,
  total: redeemBatches.total,
  usedCount: redeemBatches.usedCount,
  createdBy: redeemBatches.createdBy,
  createdAt: redeemBatches.createdAt,
};

const CODE_COLUMNS = {
  id: redeemCodes.id,
  codeHash: redeemCodes.codeHash,
  status: redeemCodes.status,
  usedBy: redeemCodes.usedBy,
  usedAt: redeemCodes.usedAt,
  expiresAt: redeemCodes.expiresAt,
};
import type {
  PaymentOrderRow,
  PaymentOrderStore,
  RedeemCodeStore,
} from '../../ports/payment-ports.js';

function tx(conn: WalletConn): DbTx {
  return conn as unknown as DbTx;
}

const ORDER_PROJECTION = {
  id: paymentOrders.id,
  provider: paymentOrders.provider,
  providerOrderId: paymentOrders.providerOrderId,
  userId: paymentOrders.userId,
  amount: paymentOrders.amount,
  currency: paymentOrders.currency,
  creditAmount: paymentOrders.creditAmount,
  status: paymentOrders.status,
  createdAt: paymentOrders.createdAt,
};

export function createPostgresPaymentOrderStore(_db: Db): PaymentOrderStore {
  return {
    async insertOrder(conn, input) {
      await tx(conn).insert(paymentOrders).values(input);
    },

    async attachProviderOrderId(conn, input) {
      await tx(conn)
        .update(paymentOrders)
        .set({ providerOrderId: input.providerOrderId, updatedAt: sql`clock_timestamp()` })
        .where(and(eq(paymentOrders.id, input.orderId), eq(paymentOrders.status, 0)));
    },

    async findByProviderOrderId(conn, input) {
      const [row] = await tx(conn)
        .select(ORDER_PROJECTION)
        .from(paymentOrders)
        .where(
          and(
            eq(paymentOrders.provider, input.provider),
            eq(paymentOrders.providerOrderId, input.providerOrderId),
          ),
        );
      return (row as PaymentOrderRow | undefined) ?? null;
    },

    async findById(conn, orderId) {
      const [row] = await tx(conn)
        .select(ORDER_PROJECTION)
        .from(paymentOrders)
        .where(eq(paymentOrders.id, orderId));
      return (row as PaymentOrderRow | undefined) ?? null;
    },

    async findByUserAndId(conn, input) {
      const [row] = await tx(conn)
        .select(ORDER_PROJECTION)
        .from(paymentOrders)
        .where(and(eq(paymentOrders.id, input.orderId), eq(paymentOrders.userId, input.userId)));
      return (row as PaymentOrderRow | undefined) ?? null;
    },

    async listByUser(conn, input) {
      const rows = await tx(conn)
        .select(ORDER_PROJECTION)
        .from(paymentOrders)
        .where(eq(paymentOrders.userId, input.userId))
        .orderBy(desc(paymentOrders.id))
        .limit(input.limit)
        .offset(input.offset);
      return rows as PaymentOrderRow[];
    },

    async markPaid(conn, input) {
      const rows = await tx(conn)
        .update(paymentOrders)
        .set({ status: 1, paidAt: input.paidAt, updatedAt: sql`clock_timestamp()` })
        .where(and(eq(paymentOrders.id, input.orderId), eq(paymentOrders.status, 0)))
        .returning({
          id: paymentOrders.id,
          creditAmount: paymentOrders.creditAmount,
          userId: paymentOrders.userId,
        });
      return rows[0] ?? null;
    },

    async markCredited(conn, input) {
      const rows = await tx(conn)
        .update(paymentOrders)
        .set({ status: 2, creditedAt: input.creditedAt, updatedAt: sql`clock_timestamp()` })
        .where(and(eq(paymentOrders.id, input.orderId), eq(paymentOrders.status, 1)))
        .returning({ id: paymentOrders.id });
      return rows.length > 0;
    },

    async expireOverdue(conn, input) {
      await tx(conn)
        .update(paymentOrders)
        .set({ status: 4, updatedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(paymentOrders.userId, input.userId),
            eq(paymentOrders.status, 0),
            sql`${paymentOrders.createdAt} < ${input.createdBefore}`,
          ),
        );
    },

    async reviveExpiredAsPaid(conn, input) {
      const rows = await tx(conn)
        .update(paymentOrders)
        .set({ status: 1, paidAt: input.paidAt, updatedAt: sql`clock_timestamp()` })
        .where(and(eq(paymentOrders.id, input.orderId), eq(paymentOrders.status, 4)))
        .returning({ id: paymentOrders.id });
      return rows.length > 0;
    },

    async markChannelFailed(conn, orderId) {
      await tx(conn)
        .update(paymentOrders)
        .set({
          status: 4,
          failureReason: 'channel_create_failed',
          updatedAt: sql`clock_timestamp()`,
        })
        .where(and(eq(paymentOrders.id, orderId), eq(paymentOrders.status, 0)));
    },

    /** 管理列表（v1 listAdminOrders 平移）：q 为订单 uuid 精确命中或用户显示名精确匹配 */
    async listAdminOrders(conn, input) {
      const where = input.q
        ? or(eq(paymentOrders.id, input.q), eq(users.displayName, input.q))
        : undefined;
      const sorts = {
        createdAt: paymentOrders.createdAt,
        amount: paymentOrders.amount,
        status: paymentOrders.status,
        id: paymentOrders.id,
      } as const;
      const column = sorts[input.sortBy];
      const orderBy = [input.order === 'asc' ? asc(column) : desc(column), desc(paymentOrders.id)];
      const [rows, countRows] = await Promise.all([
        tx(conn)
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
        tx(conn)
          .select({ count: sql<number>`count(*)::int` })
          .from(paymentOrders)
          .leftJoin(users, eq(paymentOrders.userId, users.id))
          .where(where),
      ]);
      return { rows: rows as AdminPaymentOrderRow[], total: countRows[0]?.count ?? 0 };
    },

    /** 手动关单：CAS 0→4（failureReason 记管理员动作;0 行 = 已关/已付/不存在） */
    async closeOrder(conn, input) {
      const rows = await tx(conn)
        .update(paymentOrders)
        .set({ status: 4, failureReason: input.reason, updatedAt: sql`clock_timestamp()` })
        .where(and(eq(paymentOrders.id, input.orderId), eq(paymentOrders.status, 0)))
        .returning({ id: paymentOrders.id });
      return rows.length > 0;
    },
  };
}

export function createPostgresRedeemCodeStore(_db: Db): RedeemCodeStore {
  return {
    async findByCodeHash(conn, codeHash) {
      const [row] = await tx(conn)
        .select({
          id: redeemCodes.id,
          batchId: redeemCodes.batchId,
          status: redeemCodes.status,
          expiresAt: redeemCodes.expiresAt,
        })
        .from(redeemCodes)
        .where(eq(redeemCodes.codeHash, codeHash));
      return row ?? null;
    },

    async claim(conn, input) {
      const rows = await tx(conn)
        .update(redeemCodes)
        .set({ status: 1, usedBy: input.userId, usedAt: input.now })
        .where(
          sql`${redeemCodes.codeHash} = ${input.codeHash} and ${redeemCodes.status} = 0
              and (${redeemCodes.expiresAt} is null or ${redeemCodes.expiresAt} > ${input.now})`,
        )
        // RETURNING 只引用本表列——批次面额经下方同事务 SELECT 读取
        // （UPDATE ... RETURNING 无 JOIN，跨表列渲染成裸列名 → 42703）
        .returning({
          id: redeemCodes.id,
          batchId: redeemCodes.batchId,
        })
        .then(async (claimed) => {
          if (claimed.length === 0) return null;
          // 批次面额（同事务读——claim 成功即锁定该批次的金额真相）
          const [batch] = await tx(conn)
            .select({ amount: redeemBatches.amount })
            .from(redeemBatches)
            .where(eq(redeemBatches.id, claimed[0]!.batchId));
          return {
            codeId: claimed[0]!.id,
            batchId: claimed[0]!.batchId,
            amount: batch?.amount ?? '0',
          };
        });
      return rows;
    },

    async insertBatchWithCodes(conn, input) {
      const [batch] = await tx(conn)
        .insert(redeemBatches)
        .values({
          name: input.batchName,
          remark: input.remark ?? null,
          amount: input.amount,
          total: input.codeHashes.length,
          createdBy: input.createdBy,
        })
        .returning({ id: redeemBatches.id });
      const codeIds = await tx(conn)
        .insert(redeemCodes)
        .values(
          input.codeHashes.map((codeHash) => ({
            batchId: batch!.id,
            codeHash,
            expiresAt: input.expiresAt,
          })),
        )
        .returning({ id: redeemCodes.id });
      return { batchId: batch!.id, codeIds: codeIds.map((row) => row.id) };
    },

    async listBatches(conn, input) {
      const where =
        input.q !== undefined ? ilike(redeemBatches.name, `%${escapeLike(input.q)}%`) : undefined;
      const sortColumn = {
        id: redeemBatches.id,
        name: redeemBatches.name,
        amount: redeemBatches.amount,
        createdAt: redeemBatches.createdAt,
      }[input.sortBy];
      const rows = await tx(conn)
        .select(BATCH_COLUMNS)
        .from(redeemBatches)
        .where(where)
        .orderBy(input.order === 'asc' ? asc(sortColumn) : desc(sortColumn))
        .limit(input.limit)
        .offset(input.offset);
      const [countRow] = await tx(conn)
        .select({ count: sql<number>`count(*)::int` })
        .from(redeemBatches)
        .where(where);
      return { rows: rows as RedeemBatchRecord[], total: countRow?.count ?? 0 };
    },

    async findBatch(conn, batchId) {
      const [row] = await tx(conn)
        .select(BATCH_COLUMNS)
        .from(redeemBatches)
        .where(eq(redeemBatches.id, batchId));
      return (row as RedeemBatchRecord | undefined) ?? null;
    },

    async listCodes(conn, input) {
      const conditions = [
        eq(redeemCodes.batchId, input.batchId),
        input.status !== undefined ? eq(redeemCodes.status, input.status) : undefined,
      ].filter((c) => c !== undefined);
      const sortColumn = { id: redeemCodes.id, usedAt: redeemCodes.usedAt }[input.sortBy];
      const rows = await tx(conn)
        .select(CODE_COLUMNS)
        .from(redeemCodes)
        .where(and(...conditions))
        .orderBy(input.order === 'asc' ? asc(sortColumn) : desc(sortColumn))
        .limit(input.limit)
        .offset(input.offset);
      const [countRow] = await tx(conn)
        .select({ count: sql<number>`count(*)::int` })
        .from(redeemCodes)
        .where(and(...conditions));
      return { rows: rows as RedeemCodeRecord[], total: countRow?.count ?? 0 };
    },

    async revokeCode(conn, input) {
      const rows = await tx(conn)
        .update(redeemCodes)
        .set({ status: 2 })
        .where(and(eq(redeemCodes.id, input.codeId), eq(redeemCodes.status, 0)))
        .returning({ id: redeemCodes.id });
      return rows.length > 0;
    },

    async listRedeemedByUser(conn, input) {
      const rows = await tx(conn)
        .select({
          codeId: redeemCodes.id,
          batchName: redeemBatches.name,
          amount: redeemBatches.amount,
          usedAt: redeemCodes.usedAt,
        })
        .from(redeemCodes)
        .innerJoin(redeemBatches, eq(redeemCodes.batchId, redeemBatches.id))
        .where(and(eq(redeemCodes.usedBy, input.userId), eq(redeemCodes.status, 1)))
        .orderBy(desc(redeemCodes.usedAt))
        .limit(input.limit)
        .offset(input.offset);
      return rows;
    },
  };
}
