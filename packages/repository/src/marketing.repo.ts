/** 营销参数仓储：marketing_settings 单行表（管理面唯一修改入口；消费方每动作读现值）。 */
import { eq } from 'drizzle-orm';
import { marketingSettings, referrals } from '@ai-gateway/db';
import { sql } from 'drizzle-orm';
import type { RepoContext } from './context.js';

export interface MarketingSettings {
  signupGiftAmount: string;
  referralSignupBonus: string;
  referralCommissionRate: string;
  updatedBy: number | null;
  updatedAt: Date;
}

/** 营销参数 + 邀请管理列表（配置 get/update、关系分页、返利流水投影） */
export class MarketingRepository {
  /** 现值（行恒存在——迁移 seed；缺行兜底返回全 0 保守值） */
  async getSettings(c: RepoContext): Promise<MarketingSettings> {
    const [row] = await c.db.select().from(marketingSettings).where(eq(marketingSettings.id, 1));
    if (!row) {
      return { signupGiftAmount: '0', referralSignupBonus: '0', referralCommissionRate: '0', updatedBy: null, updatedAt: new Date(0) };
    }
    return {
      signupGiftAmount: row.signupGiftAmount,
      referralSignupBonus: row.referralSignupBonus,
      referralCommissionRate: row.referralCommissionRate,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
    };
  }

  /** 更新（整行 upsert；DB CHECK 把域关死——负数/比例越界由调用方 zod 先拦） */
  async updateSettings(
    c: RepoContext,
    input: { signupGiftAmount: string; referralSignupBonus: string; referralCommissionRate: string; updatedBy: number },
  ): Promise<MarketingSettings> {
    await c.db
      .insert(marketingSettings)
      .values({ id: 1, ...input, updatedBy: input.updatedBy, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: marketingSettings.id,
        set: { ...input, updatedBy: input.updatedBy, updatedAt: new Date() },
      });
    return this.getSettings(c);
  }

  /** 邀请关系列表（双方邮箱 join；q 命中任一邮箱；含该邀请人累计佣金——账本聚合） */
  async listRelations(
    c: RepoContext,
    input: { q?: string; limit: number; offset: number },
  ): Promise<{
    rows: Array<{
      id: number;
      inviterUserId: number;
      inviterEmail: string | null;
      inviteeUserId: number;
      inviteeEmail: string | null;
      status: number;
      createdAt: Date;
      commissionTotal: string;
    }>;
    total: number;
  }> {
    const pattern = input.q ? `%${input.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%` : null;
    const conditions = pattern
      ? sql`inviter_u.email ilike ${pattern} or invitee_u.email ilike ${pattern}`
      : sql`true`;
    const [rows, countRows] = await Promise.all([
      c.db.execute(sql`
        select r.id, r.inviter_user_id, r.invitee_user_id, r.status, r.created_at,
               inviter_u.email as inviter_email, invitee_u.email as invitee_email,
               coalesce((
                 select sum(leg.amount) from wallet_transactions wt
                 join wallet_legs leg on leg.transaction_id = wt.id
                 join wallet_accounts wa on wa.id = leg.account_id and wa.user_id = r.inviter_user_id
                 where wt.ref_type = 'referral'
               ), 0)::text as commission_total
        from referrals r
        join users inviter_u on inviter_u.id = r.inviter_user_id
        join users invitee_u on invitee_u.id = r.invitee_user_id
        where ${conditions}
        order by r.id desc
        limit ${input.limit} offset ${input.offset}
      `),
      c.db.execute(sql`
        select count(*)::int as total from referrals r
        join users inviter_u on inviter_u.id = r.inviter_user_id
        join users invitee_u on invitee_u.id = r.invitee_user_id
        where ${conditions}
      `),
    ]);
    const list = rows.rows as Array<Record<string, unknown>>;
    return {
      rows: list.map((r) => ({
        id: Number(r.id),
        inviterUserId: Number(r.inviter_user_id),
        inviterEmail: (r.inviter_email as string | null) ?? null,
        inviteeUserId: Number(r.invitee_user_id),
        inviteeEmail: (r.invitee_email as string | null) ?? null,
        status: Number(r.status),
        createdAt: r.created_at as Date,
        commissionTotal: String(r.commission_total ?? '0'),
      })),
      total: Number((countRows.rows[0] as { total: number } | undefined)?.total ?? 0),
    };
  }

  /** 关系封禁/恢复（作弊判定：封禁 = worker 停止派奖；历史入账不动） */
  async setRelationStatus(c: RepoContext, input: { relationId: number; status: 0 | 1 }): Promise<boolean> {
    const rows = await c.db
      .update(referrals)
      .set({ status: input.status })
      .where(eq(referrals.id, input.relationId))
      .returning({ id: referrals.id });
    return rows.length > 0;
  }

  /** 返利流水（佣金 / 邀请注册奖励 / 注册赠送三类，账本投影——资金单一真相） */
  async listPayouts(
    c: RepoContext,
    input: { kind: 'commission' | 'referral_signup' | 'gift'; limit: number; offset: number },
  ): Promise<{
    rows: Array<{ id: number; kind: string; refType: string; refId: string; memo: string | null; createdAt: Date }>;
    total: number;
  }> {
    // 三类同视图：佣金与注册奖励同 ref_type='referral'（refId 前缀区分），赠送走 gift
    const kindCondition =
      input.kind === 'commission'
        ? sql`ref_type = 'referral' and ref_id like 'referral-commission:%'`
        : input.kind === 'referral_signup'
          ? sql`ref_type = 'referral' and ref_id like 'referral-signup:%'`
          : sql`ref_type = 'gift' and ref_id like 'signup:%'`;
    const [rows, countRows] = await Promise.all([
      c.db.execute(sql`
        select id, kind, ref_type, ref_id, memo, created_at from wallet_transactions
        where ${kindCondition}
        order by id desc
        limit ${input.limit} offset ${input.offset}
      `),
      c.db.execute(sql`select count(*)::int as total from wallet_transactions where ${kindCondition}`),
    ]);
    const list = rows.rows as Array<Record<string, unknown>>;
    return {
      rows: list.map((r) => ({
        id: Number(r.id),
        kind: String(r.kind),
        refType: String(r.ref_type),
        refId: String(r.ref_id),
        memo: (r.memo as string | null) ?? null,
        createdAt: r.created_at as Date,
      })),
      total: Number((countRows.rows[0] as { total: number } | undefined)?.total ?? 0),
    };
  }
}
