/**
 * 邀请佣金日结集成套件（真 PG）：昨日窗口聚合 × 比例 → wallet 入账；
 * 幂等（同日重跑只入一次）/ 窗口边界（今日消费不计）/ 停止返佣（status=1 不计）/
 * 比例关闭（rate=0 直接返回）。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '@ai-gateway/db';
import { users } from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import { createWallet, systemContext, type RunContext } from '@ai-gateway/service';
import { Decimal } from '@ai-gateway/domain';
import { runReferralCommissionOnce } from '../tasks/referral-commission.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const ctx: RunContext = systemContext('v2ref-suite');
/** 与 worker 装配同口径（refType 'referral' 白名单） */
const wallet = createWallet({
  db,
  guards: {
    refTypes: ['referral'],
    currencies: ['CNY'],
    internalAccounts: ['outside', 'platform_revenue'],
  },
  currency: 'CNY',
});

const createdUsers: number[] = [];
const createdLogs: string[] = [];

async function newUser(): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      issuer: 'v2ref',
      subject: `v2ref-${randomUUID()}`,
      identityProvider: 'local',
    })
    .returning({ id: users.id });
  createdUsers.push(row!.id);
  return row!.id;
}

/** 直插一条已结算用量（commission 聚合的输入侧；requestId 无 FK，随机即可） */
async function settledUsage(userId: number, amount: string, createdAt: Date, status = 0): Promise<void> {
  const requestId = randomUUID();
  createdLogs.push(requestId);
  await db.$client.query(
    `insert into usage_logs (request_id, user_id, credential_type, external_model, real_model,
       coefficient, amount, plan_amount, payg_amount, billed_by, status, created_at)
     values ($1,$2,'key','gpt-x','gpt-real','1',$3,$3,'0','plan',$4,$5)`,
    [requestId, userId, amount, status, createdAt.toISOString()],
  );
}

async function newReferral(inviter: number, invitee: number, status = 0): Promise<void> {
  await db.$client.query(
    'insert into referrals (inviter_user_id, invitee_user_id, status) values ($1,$2,$3)',
    [inviter, invitee, status],
  );
}

/** 固定时钟：now = 2026-08-19T12:00:00Z（结算窗口 = 08-18 全天 UTC） */
const NOW = new Date('2026-08-19T12:00:00Z');
const YESTERDAY = (h: number) => new Date(`2026-08-18T${String(h).padStart(2, '0')}:00:00Z`);
const TODAY = new Date('2026-08-19T01:00:00Z');

async function balanceOf(userId: number): Promise<string> {
  const accounts = await wallet.accounts(ctx, userId);
  return accounts[0]?.balance ?? '0';
}

afterAll(async () => {
  // 原生参数化清理（零 drizzle import，FK 顺序：用量/关系先于用户）
  if (createdLogs.length) {
    await db.$client.query('delete from usage_logs where request_id = any($1::uuid[])', [createdLogs]);
  }
  if (createdUsers.length) {
    await db.$client.query('delete from referrals where invitee_user_id = any($1)', [createdUsers]);
    await db.$client.query('delete from users where id = any($1)', [createdUsers]);
  }
  await db.$client.end().catch(() => {});
});

describe('佣金日结', () => {
  it('昨日消费 × 比例入账；同日重跑幂等不二次入账', async () => {
    const inviter = await newUser();
    const invitee = await newUser();
    await newReferral(inviter, invitee);
    await settledUsage(invitee, '10', YESTERDAY(6));
    await settledUsage(invitee, '5.5', YESTERDAY(20));

    const once = await runReferralCommissionOnce({ db, wallet, commissionRate: 0.1, now: () => NOW });
    expect(once.credited).toBe(1);
    expect(new Decimal(await balanceOf(inviter)).eq('1.55')).toBe(true);

    // 重跑（补跑/并发副本落败路径）：wallet 自然键幂等
    const again = await runReferralCommissionOnce({ db, wallet, commissionRate: 0.1, now: () => NOW });
    expect(again.credited).toBe(0);
    expect(new Decimal(await balanceOf(inviter)).eq('1.55')).toBe(true);
  });

  it('窗口边界：今日消费不计入昨日佣金', async () => {
    const inviter = await newUser();
    const invitee = await newUser();
    await newReferral(inviter, invitee);
    await settledUsage(invitee, '100', TODAY);

    const once = await runReferralCommissionOnce({ db, wallet, commissionRate: 0.1, now: () => NOW });
    expect(once.credited).toBe(0);
    expect(new Decimal(await balanceOf(inviter)).eq('0')).toBe(true);
  });

  it('停止返佣（关系 status=1）与未结算行（status=1）都排除', async () => {
    const inviter = await newUser();
    const invitee = await newUser();
    await newReferral(inviter, invitee, 1); // 停止返佣
    await settledUsage(invitee, '10', YESTERDAY(12));

    const inviter2 = await newUser();
    const invitee2 = await newUser();
    await newReferral(inviter2, invitee2);
    await settledUsage(invitee2, '10', YESTERDAY(12), 1); // 未结算

    const once = await runReferralCommissionOnce({ db, wallet, commissionRate: 0.1, now: () => NOW });
    expect(once.credited).toBe(0);
    expect(new Decimal(await balanceOf(inviter)).eq('0')).toBe(true);
    expect(new Decimal(await balanceOf(inviter2)).eq('0')).toBe(true);
  });

  it('比例关闭（rate=0）：零查询零入账', async () => {
    const once = await runReferralCommissionOnce({ db, wallet, commissionRate: 0, now: () => NOW });
    expect(once).toEqual({ credited: 0 });
  });
});
