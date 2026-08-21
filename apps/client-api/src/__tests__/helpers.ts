/**
 * 集成测试公共基建：真 PG（随机标识隔离）+ 用户/管理员/兑换批次造数 + 统一清理。
 * 资损断言统一 Decimal .eq()（PG numeric 尾零不干扰）。
 */
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { afterAll } from 'vitest';
import { createDb } from '@ai-gateway/db';
import {
  admins,
  apiKeys,
  apps,
  orgInvitations,
  orgMembers,
  organizations,
  paymentOrders,
  plans,
  redeemBatches,
  redeemCodes,
  referrals,
  usageLogs,
  userSubscriptions,
  users,
} from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import { Decimal } from '@ai-gateway/domain';
import { createWallet } from '@ai-gateway/service';

export const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);

/** 与装配同口径的 wallet（fail-closed 白名单 = client-api 的五类业务域） */
export const wallet = createWallet({
  db,
  currency: 'CNY',
  guards: {
    refTypes: ['gift', 'redeem', 'topup', 'subscription', 'referral'],
    currencies: ['CNY'],
    internalAccounts: ['outside', 'platform_revenue'],
  },
});

const createdUsers: number[] = [];
const createdAdmins: number[] = [];
const createdBatches: number[] = [];
const createdPlans: number[] = [];
const createdOrgs: number[] = [];

export const uid = (tag: string): string => `cav2-${tag}-${randomUUID().slice(0, 8)}`;

/** 恒放行的防护替身（服务依赖已必填；需要真实锁定语义的测试自建 guard） */
export const openKeyGuard = {
  isLocked: async () => ({ locked: false, retryAfterSec: 0 }),
  recordFailure: async () => ({ locked: false, retryAfterSec: 0 }),
  recordSuccess: async () => undefined,
} as const;

export const openIpGuard = {
  isLocked: async () => ({ locked: false, retryAfterSec: 0 }),
  recordFailure: async () => ({ locked: false, retryAfterSec: 0 }),
} as const;

/** 恒不触发的限流计数器替身（hit 永远返回 1 = 首次） */
export const neverHitCounter = { hit: async () => 1 } as const;
export const email = (): string => `${uid('u')}@example.com`;
export const password = (): string => 'correct-horse-battery';

export async function newAdmin(): Promise<number> {
  const [row] = await db
    .insert(admins)
    .values({ email: email(), passwordHash: 'scrypt:32768:8:1:00:00', displayName: 'test' })
    .returning({ id: admins.id });
  createdAdmins.push(row!.id);
  return row!.id;
}

/** 直插本地用户（不经注册服务——服务路径在 auth 套件里单独覆盖） */
export async function newUser(): Promise<{ id: number; email: string; passwordHash: string }> {
  const { hashPassword } = await import('@ai-gateway/identity-core');
  const mail = email();
  const hash = await hashPassword(password());
  const [row] = await db
    .insert(users)
    .values({
      issuer: 'local',
      subject: mail,
      identityProvider: 'local',
      email: mail,
      displayName: mail.split('@')[0],
      passwordHash: hash,
    })
    .returning({ id: users.id });
  createdUsers.push(row!.id);
  return { id: row!.id, email: mail, passwordHash: hash };
}

export async function trackUser(id: number): Promise<void> {
  createdUsers.push(id);
}

/** 企业用户（团队套餐闸门要求 isEnterprise） */
export async function newEnterpriseUser(): Promise<{ id: number; email: string }> {
  const account = await newUser();
  await db
    .update(users)
    .set({ isEnterprise: true })
    .where(inArray(users.id, [account.id]));
  return { id: account.id, email: account.email };
}

/** 套餐目录造数（购买/变更测试夹具；返回 planId） */
export async function newPlan(input: {
  name?: string;
  price: string;
  quotaAmount: string;
  periodDays?: number;
  sortOrder?: number | null;
  allowSeats?: boolean;
  kind?: 'subscription' | 'pack';
  status?: number;
}): Promise<number> {
  const [row] = await db
    .insert(plans)
    .values({
      name: input.name ?? uid('plan'),
      kind: input.kind ?? 'subscription',
      sortOrder: input.sortOrder ?? null,
      price: input.price,
      periodDays: input.periodDays ?? 30,
      quotaAmount: input.quotaAmount,
      allowSeats: input.allowSeats ?? false,
      status: input.status ?? 0,
    })
    .returning({ id: plans.id });
  createdPlans.push(row!.id);
  return row!.id;
}

export async function trackOrg(orgId: number): Promise<void> {
  createdOrgs.push(orgId);
}

/** 兑换码批次 + 单码（明文返回——调用方持有明文做兑换请求） */
export async function newRedeemCode(input: {
  amount: string;
  expiresAt?: Date | null;
}): Promise<{ plaintext: string; codeId: number; batchId: number }> {
  const { randomBytes, createHash } = await import('node:crypto');
  const adminId = await newAdmin();
  const [batch] = await db
    .insert(redeemBatches)
    .values({ name: uid('batch'), amount: input.amount, total: 1, createdBy: adminId })
    .returning({ id: redeemBatches.id });
  createdBatches.push(batch!.id);
  const plaintext = randomBytes(16).toString('hex');
  const [code] = await db
    .insert(redeemCodes)
    .values({
      batchId: batch!.id,
      codeHash: createHash('sha256').update(plaintext).digest('hex'),
      expiresAt: input.expiresAt ?? null,
    })
    .returning({ id: redeemCodes.id });
  return { plaintext, codeId: code!.id, batchId: batch!.id };
}

/** 用户 CNY 余额（已结算口径——可用额见 AccountSnapshot.inFlight/creditLimit 组合） */
export async function balanceOf(userId: number): Promise<string> {
  const accounts = await wallet.accounts(
    { requestId: `probe-${randomUUID()}`, actor: { kind: 'system' }, traceParent: null },
    userId,
  );
  const cny = accounts.find((a) => a.currency === 'CNY');
  return cny ? cny.balance : '0';
}

export function expectAmountEq(actual: string, expected: string): void {
  if (!new Decimal(actual).eq(new Decimal(expected))) {
    throw new Error(`amount mismatch: ${actual} != ${expected}`);
  }
}

afterAll(async () => {
  // FK 全 NO ACTION：子表先于父表（订阅→计划；组织三表→组织；usage→用户）。
  // 组织可能由购买事务在域内创建（非测试直插）——按 owner 收编后统一清理。
  const ownedOrgs = createdUsers.length
    ? await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(inArray(organizations.ownerUserId, createdUsers))
    : [];
  const orgIds = [...new Set([...createdOrgs, ...ownedOrgs.map((r) => r.id)])];

  if (createdUsers.length) {
    await db.delete(usageLogs).where(inArray(usageLogs.userId, createdUsers));
    await db.delete(apiKeys).where(inArray(apiKeys.userId, createdUsers));
    await db.delete(paymentOrders).where(inArray(paymentOrders.userId, createdUsers));
    // Apps 先解绑订阅引用（记录保留），再删订阅行
    await db.update(apps).set({ subscriptionId: null }).where(inArray(apps.userId, createdUsers));
    await db.delete(apps).where(inArray(apps.userId, createdUsers));
    await db.delete(userSubscriptions).where(inArray(userSubscriptions.userId, createdUsers));
    // 兑换历史引用解绑（记录保留，归属清空）
    await db
      .update(redeemCodes)
      .set({ usedBy: null })
      .where(inArray(redeemCodes.usedBy, createdUsers));
  }
  if (orgIds.length) {
    await db.delete(orgInvitations).where(inArray(orgInvitations.orgId, orgIds));
    await db.delete(orgMembers).where(inArray(orgMembers.orgId, orgIds));
    await db.delete(organizations).where(inArray(organizations.id, orgIds));
  }
  if (createdUsers.length) {
    await db.delete(orgMembers).where(inArray(orgMembers.userId, createdUsers));
    await db.delete(referrals).where(inArray(referrals.inviteeUserId, createdUsers));
    await db.delete(users).where(inArray(users.id, createdUsers));
  }
  if (createdBatches.length) {
    await db.delete(redeemCodes).where(inArray(redeemCodes.batchId, createdBatches));
    await db.delete(redeemBatches).where(inArray(redeemBatches.id, createdBatches));
  }
  if (createdAdmins.length) await db.delete(admins).where(inArray(admins.id, createdAdmins));
  if (createdPlans.length) await db.delete(plans).where(inArray(plans.id, createdPlans));
  await db.$client.end().catch(() => {});
});

/** 营销参数测试基线（= 迁移 0073 seed 值）：测试触碰 marketing_settings 必须
 *  进基线、出基线——「快照恢复」会沿套件链传递污染（前一套件改值未恢复，
 *  后一套件会把脏值当原值恢复） */
export const MARKETING_BASELINE = {
  signupGiftAmount: '0',
  referralSignupBonus: '1',
  referralCommissionRate: '0.1',
} as const;

export interface MarketingSnapshot {
  signupGiftAmount: string;
  referralSignupBonus: string;
  referralCommissionRate: string;
  updatedBy: number | null;
}

/**
 * 快照当前真实配置（含修改人/时间）：测试套件 beforeAll 取、afterAll 原样恢复。
 * 固定基线只做测试期间的稳定初值；出基线必须回真实值——marketing_settings 是
 * 单行全局表，测试若以基线收尾会把共享库上的运营配置覆盖掉（含 updated_by 抹 null）。
 */
export async function snapshotMarketingSettings(): Promise<MarketingSnapshot> {
  const { eq } = await import('drizzle-orm');
  const { marketingSettings } = await import('@ai-gateway/db');
  const [row] = await db.select().from(marketingSettings).where(eq(marketingSettings.id, 1));
  return (
    row ?? {
      signupGiftAmount: MARKETING_BASELINE.signupGiftAmount,
      referralSignupBonus: MARKETING_BASELINE.referralSignupBonus,
      referralCommissionRate: MARKETING_BASELINE.referralCommissionRate,
      updatedBy: null,
    }
  );
}

/** 恢复快照（updatedBy 原样回填，运营侧「最后修改人」不被测试抹掉） */
export async function restoreMarketingSettings(snapshot: MarketingSnapshot): Promise<void> {
  const { eq } = await import('drizzle-orm');
  const { marketingSettings } = await import('@ai-gateway/db');
  await db
    .update(marketingSettings)
    .set({
      signupGiftAmount: snapshot.signupGiftAmount,
      referralSignupBonus: snapshot.referralSignupBonus,
      referralCommissionRate: snapshot.referralCommissionRate,
      updatedBy: snapshot.updatedBy,
    })
    .where(eq(marketingSettings.id, 1));
}

export async function resetMarketingSettings(): Promise<void> {
  const { eq } = await import('drizzle-orm');
  const { marketingSettings } = await import('@ai-gateway/db');
  await db
    .update(marketingSettings)
    .set({ ...MARKETING_BASELINE, updatedBy: null })
    .where(eq(marketingSettings.id, 1));
}
