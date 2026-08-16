import { eq, and, sql, gte, lte, desc, gt, isNull } from 'drizzle-orm';
import { users, rateCards, transactions, userSubscriptions, plans } from '@ai-gateway/db/schema';
import { z } from 'zod';
import {
  HttpError, recordAudit, paginateQuery,
  listQuerySchema, buildList, countAll } from '@ai-gateway/http';
import type { ClientServices } from './index.js';

/**
 * 用户面板：当前用户信息与资金流水（api-contract §4.1 / §4.3）。
 * 写操作（改显示名）与读查询同层；路由只做入参校验与响应。
 */

export const txQuerySchema = listQuerySchema.extend({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export async function getMe(s: ClientServices, userId: number) {
  const rows = await s.db
    .select({
      id: users.id,
      subject: users.subject,
      email: users.email,
      displayName: users.displayName,
      rateCardId: users.rateCardId,
      rateCardName: rateCards.name,
      balance: users.balance,
      status: users.status,
      isEnterprise: users.isEnterprise,
      rpmLimit: users.rpmLimit,
      tpmLimit: users.tpmLimit,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .leftJoin(rateCards, eq(users.rateCardId, rateCards.id))
    .where(eq(users.id, userId))
    .limit(1);
  if (rows.length === 0) throw new HttpError('USER_NOT_FOUND', '用户不存在');
  return rows[0];
}

/** 修改显示名称（自助，1-32 字符去空白） */
export async function updateDisplayName(s: ClientServices, userId: number, displayName: string) {
  const [updated] = await s.db
    .update(users)
    .set({ displayName, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ id: users.id, displayName: users.displayName });
  if (!updated) throw new HttpError('USER_NOT_FOUND', '用户不存在');
  void recordAudit(s.db, {
    actor: 'user',
    action: 'user.display_name_change',
    targetType: 'user',
    targetId: userId,
    detail: { displayName },
  });
  return updated.displayName;
}

/** 当前「个人」订阅（套餐/生效期/剩余额度），无有效订阅返回 null；组织订阅归 orgs 服务 */
export async function getCurrentSubscription(s: ClientServices, userId: number) {
  const rows = await s.db
    .select({
      id: userSubscriptions.id,
      planId: userSubscriptions.planId,
      planName: plans.name,
      planSortOrder: plans.sortOrder,
      allowSeats: plans.allowSeats,
      quantity: userSubscriptions.quantity,
      startAt: userSubscriptions.startAt,
      endAt: userSubscriptions.endAt,
      quotaAmount: userSubscriptions.quotaAmount,
      usedAmount: userSubscriptions.usedAmount,
      reservedAmount: userSubscriptions.reservedAmount,
      price: userSubscriptions.price,
      /** 剩余额度（元）= 额度 - 已用 - 在途预占，与网关授权口径一致 */
      remainingAmount: sql<string>`${userSubscriptions.quotaAmount} - ${userSubscriptions.usedAmount} - ${userSubscriptions.reservedAmount}`,
      periodDays: plans.periodDays,
      /** 续费总价（当前档价 × 席位），供前端确认弹窗展示 */
      renewPrice: sql<string>`${plans.price} * ${userSubscriptions.quantity}::numeric`,
      /** 当前档单价（元/席），供升级/加席位弹窗算补差价 */
      planPrice: plans.price,
      /** 剩余价值（元）= 总价 × (额度-已用-在途)/额度，与变更补差价同口径 */
      remainingValue: sql<string>`CASE WHEN ${userSubscriptions.quotaAmount} > 0 THEN ${userSubscriptions.price} * (${userSubscriptions.quotaAmount} - ${userSubscriptions.usedAmount} - ${userSubscriptions.reservedAmount}) / ${userSubscriptions.quotaAmount} ELSE 0 END`,
    })
    .from(userSubscriptions)
    .innerJoin(plans, eq(userSubscriptions.planId, plans.id))
    .where(
      and(
        eq(userSubscriptions.userId, userId),
        isNull(userSubscriptions.orgId),
        eq(userSubscriptions.status, 0),
        gt(userSubscriptions.endAt, new Date()),
      ),
    )
    .orderBy(desc(userSubscriptions.id))
    .limit(1);
  return rows[0] ?? null;
}

export async function listMyTransactions(s: ClientServices, userId: number, q: z.infer<typeof txQuerySchema>) {
  const { page, limit, offset, where, orderBy } = buildList(q, {
    search: [transactions.remark, transactions.refId, transactions.type],
    conditions: [
      eq(transactions.userId, userId),
      q.from ? gte(transactions.createdAt, new Date(q.from)) : undefined,
      q.to ? lte(transactions.createdAt, new Date(q.to)) : undefined,
    ],
    sort: {
      by: { id: transactions.id, amount: transactions.amount, createdAt: transactions.createdAt },
      fallback: 'createdAt',
      tiebreaker: transactions.id,
    },
  });
  // 显式列（T6）：select() 全列会把 transactions.created_by（操作管理员 id）泄给终端用户
  const txColumns = {
    id: transactions.id,
    userId: transactions.userId,
    type: transactions.type,
    amount: transactions.amount,
    balanceBefore: transactions.balanceBefore,
    balanceAfter: transactions.balanceAfter,
    refType: transactions.refType,
    refId: transactions.refId,
    remark: transactions.remark,
    createdAt: transactions.createdAt,
  };
  return paginateQuery(
    page,
    s.db.select(txColumns).from(transactions).where(where).orderBy(...orderBy).limit(limit).offset(offset),
    countAll(s.db, transactions, where),
  );
}
