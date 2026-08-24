/**
 * billing-store 的管理读侧面方法族（U6：plans 目录 CRUD / 订阅管理列表 / 死信复审
 * 原语——admin-api P1 消费）——按聚合边界拆分（铁律 5）。
 * 订阅管理列表的 users/plans 富化在 SQL 物理层 join 完成（不引 accounts 依赖）。
 */
import { and, asc, desc, eq, ilike, sql } from 'drizzle-orm';
import { billingRequests, plans, userSubscriptions, users, type Db } from '@tillgate/db';
import { Decimal } from '../../domain/money.js';
import type {
  AdminSubscriptionRow,
  BillingStore,
  DeadCaseRow,
  PlanRecord,
} from '../../ports/billing-store.js';
import type { WalletConn } from '../../ports/wallet-store.js';

function tx(conn: WalletConn) {
  return conn as unknown as Db;
}

/** LIKE 字面匹配转义（% _ \） */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (m) => `\\${m}`);
}

const PLAN_SORT_COLUMNS = {
  id: plans.id,
  name: plans.name,
  status: plans.status,
  price: plans.price,
  sortOrder: plans.sortOrder,
} as const;

const PLAN_COLUMNS = {
  id: plans.id,
  name: plans.name,
  kind: plans.kind,
  sortOrder: plans.sortOrder,
  price: plans.price,
  periodDays: plans.periodDays,
  quotaAmount: plans.quotaAmount,
  allowSeats: plans.allowSeats,
  status: plans.status,
};

/** 剩余额度投影:quota − used − reserved（存储精度十进制运算） */
function remainingOf(quotaAmount: string, usedAmount: string, reservedAmount: string): string {
  return new Decimal(quotaAmount).minus(usedAmount).minus(reservedAmount).toString();
}

// eslint-disable-next-line max-lines-per-function -- 管理面 SQL 查询构造平铺(条件/排序/分页)
export function adminMethods(
  _db: Db,
): Pick<
  BillingStore,
  | 'listAdminPlans'
  | 'insertPlan'
  | 'patchPlan'
  | 'deletePlan'
  | 'countSubscriptionsAnyStatus'
  | 'listAdminSubscriptions'
  | 'listDeadCases'
  | 'casReviewRetryDead'
  | 'casReviewAbandonDead'
> {
  return {
    async listAdminPlans(conn, query) {
      const where =
        query.q !== undefined ? ilike(plans.name, `%${escapeLike(query.q)}%`) : undefined;
      const rows = await tx(conn)
        .select(PLAN_COLUMNS)
        .from(plans)
        .where(where)
        .orderBy(
          query.order === 'asc'
            ? asc(PLAN_SORT_COLUMNS[query.sortBy])
            : desc(PLAN_SORT_COLUMNS[query.sortBy]),
        )
        .limit(query.limit)
        .offset(query.offset);
      const [countRow] = await tx(conn)
        .select({ count: sql<number>`count(*)::int` })
        .from(plans)
        .where(where);
      return { rows: rows as PlanRecord[], total: countRow?.count ?? 0 };
    },

    async insertPlan(conn, values) {
      const [row] = await tx(conn).insert(plans).values(values).returning(PLAN_COLUMNS);
      return row as PlanRecord;
    },

    async patchPlan(conn, input) {
      const [row] = await tx(conn)
        .update(plans)
        .set(input.patch)
        .where(eq(plans.id, input.planId))
        .returning(PLAN_COLUMNS);
      return (row as PlanRecord | undefined) ?? null;
    },

    async deletePlan(conn, planId) {
      const rows = await tx(conn)
        .delete(plans)
        .where(eq(plans.id, planId))
        .returning({ id: plans.id });
      return rows.length > 0;
    },

    async countSubscriptionsAnyStatus(conn, planId) {
      const [row] = await tx(conn)
        .select({ count: sql<number>`count(*)::int` })
        .from(userSubscriptions)
        .where(eq(userSubscriptions.planId, planId));
      return row?.count ?? 0;
    },

    // eslint-disable-next-line max-lines-per-function -- 管理面 SQL 查询构造平铺(条件/排序/分页)
    async listAdminSubscriptions(conn, input) {
      const conditions = [
        input.planId !== undefined ? eq(userSubscriptions.planId, input.planId) : undefined,
        input.userId !== undefined ? eq(userSubscriptions.userId, input.userId) : undefined,
        input.status !== undefined ? eq(userSubscriptions.status, input.status) : undefined,
        input.q !== undefined
          ? sql`(${users.subject} ilike ${`%${escapeLike(input.q)}%`} or ${users.displayName} ilike ${`%${escapeLike(input.q)}%`})`
          : undefined,
      ].filter((c) => c !== undefined);
      const where = conditions.length > 0 ? and(...conditions) : undefined;
      const sortColumn = {
        id: userSubscriptions.id,
        createdAt: userSubscriptions.createdAt,
        startAt: userSubscriptions.startAt,
        endAt: userSubscriptions.endAt,
        usedAmount: userSubscriptions.usedAmount,
      }[input.sortBy];

      const rows = await tx(conn)
        .select({
          id: userSubscriptions.id,
          userId: userSubscriptions.userId,
          userSubject: users.subject,
          userDisplayName: users.displayName,
          planId: userSubscriptions.planId,
          planName: plans.name,
          startAt: userSubscriptions.startAt,
          endAt: userSubscriptions.endAt,
          quotaAmount: userSubscriptions.quotaAmount,
          usedAmount: userSubscriptions.usedAmount,
          reservedAmount: userSubscriptions.reservedAmount,
          quantity: userSubscriptions.quantity,
          price: userSubscriptions.price,
          status: userSubscriptions.status,
          createdAt: userSubscriptions.createdAt,
        })
        .from(userSubscriptions)
        .innerJoin(users, eq(users.id, userSubscriptions.userId))
        .innerJoin(plans, eq(plans.id, userSubscriptions.planId))
        .where(where)
        .orderBy(input.order === 'asc' ? asc(sortColumn) : desc(sortColumn))
        .limit(input.limit)
        .offset(input.offset);
      const [countRow] = await tx(conn)
        .select({ count: sql<number>`count(*)::int` })
        .from(userSubscriptions)
        .innerJoin(users, eq(users.id, userSubscriptions.userId))
        .where(where);

      const enriched: AdminSubscriptionRow[] = rows.map((row) => ({
        ...row,
        remainingAmount: remainingOf(row.quotaAmount, row.usedAmount, row.reservedAmount),
      }));
      return { rows: enriched, total: countRow?.count ?? 0 };
    },

    async listDeadCases(conn, input) {
      const rows = await tx(conn)
        .select({
          requestId: billingRequests.requestId,
          userId: billingRequests.userId,
          status: billingRequests.status,
          revision: billingRequests.revision,
          attempt: billingRequests.settlementAttempts,
          failureCode: billingRequests.failureCode,
          lastError: billingRequests.lastError,
          reservedAmount: billingRequests.reservedAmount,
          createdAt: billingRequests.createdAt,
        })
        .from(billingRequests)
        .where(eq(billingRequests.status, 'dead'))
        .orderBy(desc(billingRequests.createdAt))
        .limit(input.limit)
        .offset(input.offset);
      const [countRow] = await tx(conn)
        .select({ count: sql<number>`count(*)::int` })
        .from(billingRequests)
        .where(eq(billingRequests.status, 'dead'));
      return { rows: rows as DeadCaseRow[], total: countRow?.count ?? 0 };
    },

    /** dead + revision 期望 → retry_wait:清失败态、重置退避与尝试计数 */
    async casReviewRetryDead(conn, input) {
      const rows = await tx(conn)
        .update(billingRequests)
        .set({
          status: 'retry_wait',
          revision: sql`${billingRequests.revision} + 1`,
          settlementAttempts: 0,
          failureCode: null,
          lastError: null,
          nextSettlementAt: input.now,
        })
        .where(
          and(
            eq(billingRequests.requestId, input.requestId),
            eq(billingRequests.status, 'dead'),
            eq(billingRequests.revision, input.expectedRevision),
          ),
        )
        .returning({ requestId: billingRequests.requestId });
      return rows.length > 0;
    },

    /** dead + revision 期望 → released:归还事实(reserved/channel)交还调用方同事务接手 */
    async casReviewAbandonDead(conn, input) {
      const rows = await tx(conn)
        .update(billingRequests)
        .set({
          status: 'released',
          revision: sql`${billingRequests.revision} + 1`,
          releasedAt: input.now,
          nextSettlementAt: null,
        })
        .where(
          and(
            eq(billingRequests.requestId, input.requestId),
            eq(billingRequests.status, 'dead'),
            eq(billingRequests.revision, input.expectedRevision),
          ),
        )
        .returning({
          reservedAmount: billingRequests.reservedAmount,
          channelId: billingRequests.channelId,
          channelReservedAmount: billingRequests.channelReservedAmount,
        });
      const [row] = rows;
      return row === undefined ? null : row;
    },
  };
}
