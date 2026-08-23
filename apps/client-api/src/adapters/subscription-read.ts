/**
 * 订阅读面（plans/user_subscriptions 属 billing；用户面列表动词暂缺——MIGRATION §8
 * 待办迁 billing facade，本适配器是过渡读面）。语义对齐 v1：目录只列上架 subscription
 * 档；我的订阅 50 行封顶、个人有效订阅优先、id 倒序。
 */
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { plans, userSubscriptions, type Db } from '@tokenlens/db';
import type { OrgSubscriptionInfo } from '../http/presenters/orgs.js';
import type { PlanRow, SubscriptionBaseRow } from '../http/presenters/subscriptions.js';

export interface SubscriptionRead {
  listPlans(): Promise<PlanRow[]>;
  mySubscriptions(userId: number): Promise<SubscriptionBaseRow[]>;
  orgSubscriptions(orgIds: readonly number[]): Promise<Map<number, OrgSubscriptionInfo>>;
}

/** 我的订阅行数封顶（v1 口径——历史订阅翻旧账走账单，不在此翻页） */
const MY_SUBSCRIPTIONS_CAP = 50;

export function createSubscriptionRead(db: Db): SubscriptionRead {
  return {
    async listPlans() {
      return db
        .select({
          id: plans.id,
          name: plans.name,
          kind: plans.kind,
          sortOrder: plans.sortOrder,
          price: plans.price,
          periodDays: plans.periodDays,
          quotaAmount: plans.quotaAmount,
          allowSeats: plans.allowSeats,
          status: plans.status,
        })
        .from(plans)
        .where(and(eq(plans.kind, 'subscription'), eq(plans.status, 0)))
        .orderBy(asc(plans.sortOrder), asc(plans.id));
    },

    async mySubscriptions(userId) {
      // 个人有效订阅（status=0 且未到期且非组织）排最前，其余按 id 倒序——v1 排序口径
      const personalActiveFirst = sql`(case when ${userSubscriptions.status} = 0
        and ${userSubscriptions.endAt} > clock_timestamp()
        and ${userSubscriptions.orgId} is null then 0 else 1 end)`;
      return db
        .select({
          id: userSubscriptions.id,
          planId: userSubscriptions.planId,
          planName: plans.name,
          planSortOrder: plans.sortOrder,
          allowSeats: plans.allowSeats,
          periodDays: plans.periodDays,
          status: userSubscriptions.status,
          orgId: userSubscriptions.orgId,
          quantity: userSubscriptions.quantity,
          quotaAmount: userSubscriptions.quotaAmount,
          usedAmount: userSubscriptions.usedAmount,
          reservedAmount: userSubscriptions.reservedAmount,
          price: userSubscriptions.price,
          planPrice: plans.price,
          startAt: userSubscriptions.startAt,
          endAt: userSubscriptions.endAt,
        })
        .from(userSubscriptions)
        .innerJoin(plans, eq(userSubscriptions.planId, plans.id))
        .where(eq(userSubscriptions.userId, userId))
        .orderBy(personalActiveFirst, desc(userSubscriptions.id))
        .limit(MY_SUBSCRIPTIONS_CAP);
    },

    async orgSubscriptions(orgIds) {
      if (orgIds.length === 0) return new Map();
      const rows = await db
        .select({
          orgId: userSubscriptions.orgId,
          subscriptionId: userSubscriptions.id,
          planName: plans.name,
          quantity: userSubscriptions.quantity,
          quotaAmount: userSubscriptions.quotaAmount,
          usedAmount: userSubscriptions.usedAmount,
          reservedAmount: userSubscriptions.reservedAmount,
        })
        .from(userSubscriptions)
        .innerJoin(plans, eq(userSubscriptions.planId, plans.id))
        .where(
          and(
            inArray(userSubscriptions.orgId, [...orgIds]),
            eq(userSubscriptions.status, 0),
            gt(userSubscriptions.endAt, sql`clock_timestamp()`),
          ),
        );
      const map = new Map<number, OrgSubscriptionInfo>();
      for (const r of rows) {
        if (r.orgId != null) {
          map.set(r.orgId, {
            subscriptionId: r.subscriptionId,
            planName: r.planName,
            quantity: r.quantity,
            quotaAmount: r.quotaAmount,
            usedAmount: r.usedAmount,
            reservedAmount: r.reservedAmount,
          });
        }
      }
      return map;
    },
  };
}
