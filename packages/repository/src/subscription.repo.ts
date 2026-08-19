/**
 * user_subscriptions 仓储：额度守卫三原语（单语句原子判定）+ 订阅行生命周期操作。
 * 额度不变量（quota − used − reserved ≥ 0）内联在 UPDATE WHERE——并发在结构上不可超扣。
 */
import { and, asc, desc, eq, gt, ilike, lte, or, sql } from 'drizzle-orm';
import type { DbTx } from '@ai-gateway/db';
import { plans, userSubscriptions, users } from '@ai-gateway/db';
import type { RepoContext } from './context.js';
import { escapeLikePattern } from './search.js';

function tx(c: RepoContext): DbTx {
  return c.db as DbTx;
}

export type QuotaReserveOutcome = 'ok' | 'inactive' | 'exhausted';

export interface SubscriptionRow {
  id: number;
  userId: number;
  planId: number;
  orgId: number | null;
  quantity: number;
  price: string;
  status: number;
  startAt: Date;
  endAt: Date;
  quotaAmount: string;
  usedAmount: string;
  reservedAmount: string;
}

const SUB_COLUMNS = {
  id: userSubscriptions.id,
  userId: userSubscriptions.userId,
  planId: userSubscriptions.planId,
  orgId: userSubscriptions.orgId,
  quantity: userSubscriptions.quantity,
  price: userSubscriptions.price,
  status: userSubscriptions.status,
  startAt: userSubscriptions.startAt,
  endAt: userSubscriptions.endAt,
  quotaAmount: userSubscriptions.quotaAmount,
  usedAmount: userSubscriptions.usedAmount,
  reservedAmount: userSubscriptions.reservedAmount,
};

export interface SubscriptionGateRow {
  userId: number;
  orgId: number | null;
  quotaAmount: string;
  usedAmount: string;
  reservedAmount: string;
}

/** 订阅仓储（无状态；方法统一接收 RepoContext——事务由用例层注入） */
export class SubscriptionRepository {
  // ---------- 额度守卫三原语 ----------

  /** 预留额度：reserved += amount；守卫 = status=0 且剩余 ≥ amount（单语句原子） */
  async tryReserveQuota(
    c: RepoContext,
    input: { subscriptionId: number; amount: string },
  ): Promise<QuotaReserveOutcome> {
    const rows = await tx(c)
      .update(userSubscriptions)
      .set({ reservedAmount: sql`${userSubscriptions.reservedAmount} + ${input.amount}::numeric` })
      .where(
        sql`${userSubscriptions.id} = ${input.subscriptionId}
            and ${userSubscriptions.status} = 0
            and ${userSubscriptions.quotaAmount} - ${userSubscriptions.usedAmount}
                - ${userSubscriptions.reservedAmount} >= ${input.amount}::numeric`,
      )
      .returning({ id: userSubscriptions.id });
    if (rows.length > 0) return 'ok';
    const [row] = await c.db
      .select({ status: userSubscriptions.status })
      .from(userSubscriptions)
      .where(eq(userSubscriptions.id, input.subscriptionId));
    return !row || row.status !== 0 ? 'inactive' : 'exhausted';
  }

  /** 结算核销：reserved −= reserved、used += consumed；守卫 = 在途足额且核销后不超总额度 */
  async trySettleQuota(
    c: RepoContext,
    input: { subscriptionId: number; reserved: string; consumed: string },
  ): Promise<boolean> {
    const rows = await tx(c)
      .update(userSubscriptions)
      .set({
        reservedAmount: sql`${userSubscriptions.reservedAmount} - ${input.reserved}::numeric`,
        usedAmount: sql`${userSubscriptions.usedAmount} + ${input.consumed}::numeric`,
      })
      .where(
        sql`${userSubscriptions.id} = ${input.subscriptionId}
            and ${userSubscriptions.reservedAmount} >= ${input.reserved}::numeric
            and ${userSubscriptions.usedAmount} + ${input.consumed}::numeric
                + (${userSubscriptions.reservedAmount} - ${input.reserved}::numeric)
                <= ${userSubscriptions.quotaAmount}`,
      )
      .returning({ id: userSubscriptions.id });
    return rows.length > 0;
  }

  /** 结算降级核销（订阅侧 D3 对称——PAYG 收满预留降级的镜像）：
   *  trySettleQuota 守卫红灯（实际用量超池容量）时改走本方法：锁行后核销
   *  min(consumed, quota − used − 其他在途)，预占全归还——差额由平台吸收记损，
   *  不再走「冲突异常 → 10 轮重试 → dead + 预扣冻结」。
   *  返回 null = 预占脱节（reserved < 参数——真红灯，调用方仍抛冲突）；
   *  否则返回核销前/后 used（差额日志的计数源）。 */
  async settleQuotaBounded(
    c: RepoContext,
    input: { subscriptionId: number; reserved: string; consumed: string },
  ): Promise<{ usedBefore: string; usedAfter: string } | null> {
    const result = await tx(c).execute(sql`
      update user_subscriptions u
      set reserved_amount = s.reserved_amount - ${input.reserved}::numeric,
          used_amount = s.used_amount + least(
            ${input.consumed}::numeric,
            greatest(
              s.quota_amount - s.used_amount - (s.reserved_amount - ${input.reserved}::numeric),
              0
            )
          )
      from (
        select id, quota_amount, used_amount, reserved_amount
        from user_subscriptions
        where id = ${input.subscriptionId} and reserved_amount >= ${input.reserved}::numeric
        for update
      ) s
      where u.id = s.id
      returning s.used_amount as used_before, u.used_amount as used_after
    `);
    const row = result.rows[0] as { used_before: string; used_after: string } | undefined;
    return row ? { usedBefore: row.used_before, usedAfter: row.used_after } : null;
  }

  /** 释放预占：reserved −= reserved（失败/取消/回收路径）；0 行 = 在途事实脱节 */
  async tryReleaseQuota(
    c: RepoContext,
    input: { subscriptionId: number; reserved: string },
  ): Promise<boolean> {
    const rows = await tx(c)
      .update(userSubscriptions)
      .set({ reservedAmount: sql`${userSubscriptions.reservedAmount} - ${input.reserved}::numeric` })
      .where(
        sql`${userSubscriptions.id} = ${input.subscriptionId}
            and ${userSubscriptions.reservedAmount} >= ${input.reserved}::numeric`,
      )
      .returning({ id: userSubscriptions.id });
    return rows.length > 0;
  }

  /** 加油包到账：quotaAmount += quota（status=0 守卫——额度不得加到失效行） */
  async tryAddQuota(
    c: RepoContext,
    input: { subscriptionId: number; quota: string },
  ): Promise<boolean> {
    const rows = await tx(c)
      .update(userSubscriptions)
      .set({ quotaAmount: sql`${userSubscriptions.quotaAmount} + ${input.quota}::numeric` })
      .where(and(eq(userSubscriptions.id, input.subscriptionId), eq(userSubscriptions.status, 0)))
      .returning({ id: userSubscriptions.id });
    return rows.length > 0;
  }

  // ---------- 订阅行生命周期 ----------

  /** 续费/升档定位：仅有效订阅（status=0）；行锁快照（折算必须基于锁后新鲜值） */
  async lockActiveSubscription(c: RepoContext, subscriptionId: number): Promise<SubscriptionRow | null> {
    const [row] = await tx(c)
      .select(SUB_COLUMNS)
      .from(userSubscriptions)
      .where(and(eq(userSubscriptions.id, subscriptionId), eq(userSubscriptions.status, 0)))
      .for('update');
    return (row as SubscriptionRow) ?? null;
  }

  /** 用户当前有效订阅（行锁；加油包目标行） */
  async lockActiveSubscriptionForUser(
    c: RepoContext,
    userId: number,
    now: Date,
  ): Promise<SubscriptionRow | null> {
    const [row] = await tx(c)
      .select(SUB_COLUMNS)
      .from(userSubscriptions)
      .where(
        and(
          eq(userSubscriptions.userId, userId),
          eq(userSubscriptions.status, 0),
          gt(userSubscriptions.endAt, now),
        ),
      )
      .for('update');
    return (row as SubscriptionRow) ?? null;
  }

  async findActiveSubscription(
    c: RepoContext,
    userId: number,
    now: Date,
  ): Promise<SubscriptionRow | null> {
    const [row] = await c.db
      .select(SUB_COLUMNS)
      .from(userSubscriptions)
      .where(
        and(
          eq(userSubscriptions.userId, userId),
          eq(userSubscriptions.status, 0),
          gt(userSubscriptions.endAt, now),
        ),
      );
    return (row as SubscriptionRow) ?? null;
  }

  /** C4：惰性翻转「已自然到期但 status 仍为 0」的行——不翻则新购买撞唯一索引死锁 */
  async expireLapsedSubscriptions(c: RepoContext, userId: number, now: Date): Promise<void> {
    await tx(c)
      .update(userSubscriptions)
      .set({ status: 1 })
      .where(
        and(
          eq(userSubscriptions.userId, userId),
          eq(userSubscriptions.status, 0),
          lte(userSubscriptions.endAt, now),
        ),
      );
  }

  async insertSubscription(
    c: RepoContext,
    values: {
      userId: number;
      planId: number;
      startAt: Date;
      endAt: Date;
      quotaAmount: string;
      quantity: number;
      price: string;
      orgId: number | null;
    },
  ): Promise<number> {
    const [row] = await tx(c)
      .insert(userSubscriptions)
      .values({ ...values, usedAmount: '0', reservedAmount: '0', status: 0 })
      .returning({ id: userSubscriptions.id });
    if (!row) throw new Error('subscription.insert_failed');
    return row.id;
  }

  /** CAS 状态迁移（续费/变更转到期 0→1、取消 0→2） */
  async casTransitionStatus(
    c: RepoContext,
    input: { subscriptionId: number; from: number; to: number },
  ): Promise<boolean> {
    const rows = await tx(c)
      .update(userSubscriptions)
      .set({ status: input.to })
      .where(
        and(eq(userSubscriptions.id, input.subscriptionId), eq(userSubscriptions.status, input.from)),
      )
      .returning({ id: userSubscriptions.id });
    return rows.length > 0;
  }

  // ---------- 订阅闸读模型（授权管线消费） ----------

  /** 订阅有效性快照（status=0 且未到期） */
  async activeSubscriptionSnapshot(
    c: RepoContext,
    subscriptionId: number,
    now: Date,
  ): Promise<SubscriptionGateRow | null> {
    const [row] = await c.db
      .select({
        userId: userSubscriptions.userId,
        orgId: userSubscriptions.orgId,
        quotaAmount: userSubscriptions.quotaAmount,
        usedAmount: userSubscriptions.usedAmount,
        reservedAmount: userSubscriptions.reservedAmount,
      })
      .from(userSubscriptions)
      .where(
        and(
          eq(userSubscriptions.id, subscriptionId),
          eq(userSubscriptions.status, 0),
          sql`${userSubscriptions.endAt} > ${now}`,
        ),
      );
    return (row as SubscriptionGateRow) ?? null;
  }

  /** 组织有效订阅详情（用户面组织列表拼装：套餐名 + 额度三元组） */
  async findOrgSubscriptionDetail(
    c: RepoContext,
    input: { orgId: number; now: Date },
  ): Promise<{
    id: number;
    planName: string | null;
    quantity: number;
    quotaAmount: string;
    usedAmount: string;
    reservedAmount: string;
  } | null> {
    const [row] = await c.db
      .select({
        id: userSubscriptions.id,
        planName: plans.name,
        quantity: userSubscriptions.quantity,
        quotaAmount: userSubscriptions.quotaAmount,
        usedAmount: userSubscriptions.usedAmount,
        reservedAmount: userSubscriptions.reservedAmount,
      })
      .from(userSubscriptions)
      .leftJoin(plans, eq(userSubscriptions.planId, plans.id))
      .where(
        and(
          eq(userSubscriptions.orgId, input.orgId),
          eq(userSubscriptions.status, 0),
          gt(userSubscriptions.endAt, input.now),
        ),
      );
    return row ?? null;
  }

  /** 用户订阅列表（含到期行；用户面「我的订阅」读模型，附套餐名） */
  /** 用户订阅列表（v1 /api/me/subscription 语义合并）：
   *  「生效中的个人订阅」置顶（前端取 rows[0] 当当前订阅——不置顶会把过期/组织
   *  订阅当生效中展示），其余按 id 倒序；行内带 v1 消费的计算字段
   *  （remainingAmount/renewPrice/planPrice/remainingValue）。 */
  async listByUser(
    c: RepoContext,
    userId: number,
  ): Promise<
    Array<{
      id: number;
      planId: number;
      planName: string | null;
      status: number;
      orgId: number | null;
      quantity: number;
      quotaAmount: string;
      usedAmount: string;
      reservedAmount: string;
      remainingAmount: string;
      renewPrice: string;
      planPrice: string;
      remainingValue: string;
      startAt: Date;
      endAt: Date;
    }>
  > {
    const rows = await c.db
      .select({
        id: userSubscriptions.id,
        planId: userSubscriptions.planId,
        planName: plans.name,
        status: userSubscriptions.status,
        orgId: userSubscriptions.orgId,
        quantity: userSubscriptions.quantity,
        quotaAmount: userSubscriptions.quotaAmount,
        usedAmount: userSubscriptions.usedAmount,
        reservedAmount: userSubscriptions.reservedAmount,
        remainingAmount: sql<string>`greatest(${userSubscriptions.quotaAmount} - ${userSubscriptions.usedAmount} - ${userSubscriptions.reservedAmount}, 0)::text`,
        renewPrice: sql<string>`coalesce(${plans.price} * ${userSubscriptions.quantity}::numeric, 0)::text`,
        planPrice: sql<string>`coalesce(${plans.price}, 0)::text`,
        remainingValue: sql<string>`(CASE WHEN ${userSubscriptions.quotaAmount} > 0 THEN ${userSubscriptions.price} * (${userSubscriptions.quotaAmount} - ${userSubscriptions.usedAmount} - ${userSubscriptions.reservedAmount}) / ${userSubscriptions.quotaAmount} ELSE 0 END)::text`,
        startAt: userSubscriptions.startAt,
        endAt: userSubscriptions.endAt,
      })
      .from(userSubscriptions)
      .leftJoin(plans, eq(userSubscriptions.planId, plans.id))
      .where(eq(userSubscriptions.userId, userId))
      .orderBy(
        sql`(case when ${userSubscriptions.status} = 0 and ${userSubscriptions.endAt} > clock_timestamp() and ${userSubscriptions.orgId} is null then 0 else 1 end)`,
        desc(userSubscriptions.id),
      )
      .limit(50);
    // cast：drizzle 对含 raw-sql 投影 + 多键 orderBy 的推断会产出两份同构匿名类型（TS2719）
    return rows as Array<{
      id: number;
      planId: number;
      planName: string | null;
      status: number;
      orgId: number | null;
      quantity: number;
      quotaAmount: string;
      usedAmount: string;
      reservedAmount: string;
      remainingAmount: string;
      renewPrice: string;
      planPrice: string;
      remainingValue: string;
      startAt: Date;
      endAt: Date;
    }>;
  }

  // ── 管理面 ──────────────────────────────────────────────────────────────────

  /** 管理列表：q 命中 用户 subject/displayName / 套餐名（双 join——计数同 join） */
  async listAdminSubscriptions(
    c: RepoContext,
    input: {
      q?: string;
      planId?: number;
      userId?: number;
      status?: number;
      sortBy: 'id' | 'createdAt' | 'startAt' | 'endAt' | 'usedAmount';
      order: 'asc' | 'desc';
      limit: number;
      offset: number;
    },
  ): Promise<{ rows: Array<AdminSubscriptionRow>; total: number }> {
    const conditions = [];
    if (input.q) {
      const pattern = escapeLikePattern(input.q);
      conditions.push(
        or(
          ilike(users.subject, pattern),
          ilike(users.displayName, pattern),
          ilike(plans.name, pattern),
        )!,
      );
    }
    if (input.planId !== undefined) conditions.push(eq(userSubscriptions.planId, input.planId));
    if (input.userId !== undefined) conditions.push(eq(userSubscriptions.userId, input.userId));
    if (input.status !== undefined) conditions.push(eq(userSubscriptions.status, input.status));
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const sorts = {
      id: userSubscriptions.id,
      createdAt: userSubscriptions.createdAt,
      startAt: userSubscriptions.startAt,
      endAt: userSubscriptions.endAt,
      usedAmount: userSubscriptions.usedAmount,
    } as const;
    const column = sorts[input.sortBy];
    const orderBy = [input.order === 'asc' ? asc(column) : desc(column), desc(userSubscriptions.id)];
    const selection = {
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
      /** 剩余额度（与授权侧同一公式：quota − used − reserved） */
      remainingAmount: sql<string>`(${userSubscriptions.quotaAmount} - ${userSubscriptions.usedAmount} - ${userSubscriptions.reservedAmount})::numeric::text`,
      quantity: userSubscriptions.quantity,
      price: userSubscriptions.price,
      orgId: userSubscriptions.orgId,
      status: userSubscriptions.status,
      createdAt: userSubscriptions.createdAt,
    };
    const [rows, countRows] = await Promise.all([
      c.db
        .select(selection)
        .from(userSubscriptions)
        .innerJoin(plans, eq(userSubscriptions.planId, plans.id))
        .innerJoin(users, eq(userSubscriptions.userId, users.id))
        .where(where)
        .orderBy(...orderBy)
        .limit(input.limit)
        .offset(input.offset),
      c.db
        .select({ count: sql<number>`count(*)::int` })
        .from(userSubscriptions)
        .innerJoin(plans, eq(userSubscriptions.planId, plans.id))
        .innerJoin(users, eq(userSubscriptions.userId, users.id))
        .where(where),
    ]);
    return { rows: rows as AdminSubscriptionRow[], total: countRows[0]?.count ?? 0 };
  }
}

/** 管理面订阅行（用户/套餐 join 富化 + 剩余额度投影） */
export interface AdminSubscriptionRow {
  id: number;
  userId: number;
  userSubject: string;
  userDisplayName: string | null;
  planId: number;
  planName: string;
  startAt: Date;
  endAt: Date;
  quotaAmount: string;
  usedAmount: string;
  reservedAmount: string;
  remainingAmount: string;
  quantity: number;
  price: string;
  orgId: number | null;
  status: number;
  createdAt: Date;
}
