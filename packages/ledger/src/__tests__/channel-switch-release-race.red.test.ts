import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import {
  billingRequests,
  channels,
  providers,
  transactions,
  usageLogs,
  users,
  userSubscriptions,
} from '@ai-gateway/db/schema';
import { Decimal } from '@ai-gateway/money';
import { createBilling } from '../billing/index.js';
import type { BillingQuote } from '../billing/types.js';

/**
 * 【红测 · 换渠道竞态】reserveChannel 换渠道路径「先释放旧敞口、后守卫预留新渠道」，
 * 守卫 UPDATE 并发输掉后 return {allowed:false} —— db.transaction 的 return 是提交，
 * 旧渠道释放被持久化，而 billing_requests 仍指向旧渠道旧金额。
 *
 * 后果：channels.upstream_reserved 少记（进货硬闸被削弱）；结算/失败释放时按
 * 账单金额二次释放 → 偷走其他请求的敞口或触发 channel_reservation_invariant → dead。
 *
 * 复现（确定性交错）：外部事务锁住目标渠道行并扣减预算（未提交）→
 * reserveChannel 的快速路径读到旧快照（预算充足）→ 释放旧渠道 → 守卫 UPDATE
 * 阻塞 → 提交外部事务 → 守卫 WHERE 在新行版本上重评估失败 → 0 行 → 早退提交。
 *
 * 预期（正确行为）：allowed:false 时旧渠道敞口必须原封不动（事务零变更提交）。
 */

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
let connected = false;

beforeAll(async () => {
  try {
    await db.query.users.findFirst({ columns: { id: true } });
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => db.$client.end().catch(() => {}));

const PREFIX = 'chsw-race';

function quote(): BillingQuote {
  return {
    maxOutputTokens: 500,
    candidates: [
      {
        mappingId: 1,
        externalModel: 'test-model',
        realModel: 'test-real',
        inputPrice: '1000',
        outputPrice: '2000',
        cacheInputPrice: '100',
        coefficient: '1',
        inputTokenUpperBound: 1_000,
        billingPolicyFingerprint: null,
      },
    ],
  };
}

interface Blocker {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  release(): void;
}

async function connectBlocker(): Promise<Blocker> {
  const pool = db.$client as unknown as {
    connect(): Promise<Blocker>;
  };
  return pool.connect();
}

async function setupUserAndChannels(suffix: string, channelCount: number) {
  const [user] = await db
    .insert(users)
    .values({
      issuer: 'test',
      subject: `${PREFIX}-${suffix}`,
      identityProvider: 'local',
      balance: '100',
    })
    .returning({ id: users.id });
  const userId = user!.id;
  const [provider] = await db
    .insert(providers)
    .values({ name: `${PREFIX}-p-${suffix}`, baseUrl: 'https://upstream.test' })
    .returning({ id: providers.id });
  const channelIds: number[] = [];
  for (let i = 0; i < channelCount; i += 1) {
    const [channel] = await db
      .insert(channels)
      .values({
        providerId: provider!.id,
        name: `${PREFIX}-c${i}-${suffix}`,
        apiKeyEnc: 'test-enc',
        upstreamBudget: '10',
      })
      .returning({ id: channels.id });
    channelIds.push(channel!.id);
  }
  return { userId, providerId: provider!.id, channelIds };
}

async function reservedOf(channelId: number): Promise<Decimal> {
  const ch = await db.query.channels.findFirst({
    where: eq(channels.id, channelId),
    columns: { upstreamReserved: true },
  });
  return new Decimal(ch?.upstreamReserved ?? 0);
}

async function cleanup(userId: number, providerId: number, channelIds: number[]): Promise<void> {
  await db.delete(billingRequests).where(eq(billingRequests.userId, userId));
  await db.delete(usageLogs).where(eq(usageLogs.userId, userId));
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(userSubscriptions).where(eq(userSubscriptions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
  for (const id of channelIds) await db.delete(channels).where(eq(channels.id, id));
  await db.delete(providers).where(eq(providers.id, providerId));
}

describe('RED: reserveChannel 换渠道竞态——拒绝路径不得提交旧敞口释放', () => {
  it('守卫预留输给并发扣减时：allowed:false 且旧渠道敞口不变', async (context) => {
    if (!connected) return context.skip();
    const suffix = randomUUID().slice(0, 8);
    const { userId, providerId, channelIds } = await setupUserAndChannels(suffix, 2);
    const [channelA, channelB] = channelIds as [number, number];
    const billing = createBilling({ db });
    const requestId = randomUUID();
    try {
      await billing.authorize({
        requestId,
        userId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      const first = await billing.reserveChannel({
        requestId,
        channelId: channelA,
        amount: '5',
      });
      expect(first.allowed).toBe(true);

      // 外部事务：锁住 B 行并扣减预算（未提交）——reserveChannel 的快速路径
      // 读到的是扣减前的已提交快照（预算 10、敞口 0），守卫 UPDATE 则阻塞于此
      const blocker = await connectBlocker();
      await blocker.query('BEGIN');
      await blocker.query(
        'UPDATE channels SET upstream_budget = upstream_budget - 8 WHERE id = $1',
        [channelB],
      );

      const switching = billing.reserveChannel({ requestId, channelId: channelB, amount: '5' });
      await new Promise((r) => setTimeout(r, 400));
      await blocker.query('COMMIT');
      blocker.release();
      const result = await switching;
      expect(result.allowed).toBe(false);

      // 【红】当前实现：旧渠道 A 的敞口已被提交释放（0），账单却仍指向 A
      // 【正确】拒绝路径事务零变更：A 敞口原封不动
      expect((await reservedOf(channelA)).toString()).toBe('5');
      const br = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.requestId, requestId),
        columns: { channelId: true, channelReservedAmount: true },
      });
      expect(br?.channelId).toBe(channelA);
      expect(new Decimal(br?.channelReservedAmount ?? '0').toString()).toBe('5');
    } finally {
      await cleanup(userId, providerId, channelIds);
    }
  });

  it('并发双切换（同请求换到两个渠道）：只允许一笔成交，敞口不得孤儿化', async (context) => {
    if (!connected) return context.skip();
    const suffix = randomUUID().slice(0, 8);
    const { userId, providerId, channelIds } = await setupUserAndChannels(suffix, 3);
    const [channelA, channelB, channelC] = channelIds as [number, number, number];
    const billing = createBilling({ db });
    const requestId = randomUUID();
    try {
      await billing.authorize({
        requestId,
        userId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      const first = await billing.reserveChannel({
        requestId,
        channelId: channelA,
        amount: '5',
      });
      expect(first.allowed).toBe(true);

      // 外部事务锁住账单行（未提交）：两笔换渠道的认领 UPDATE 都阻塞在这把锁上
      const blocker = await connectBlocker();
      await blocker.query('BEGIN');
      await blocker.query('UPDATE billing_requests SET updated_at = now() WHERE request_id = $1', [
        requestId,
      ]);

      const toB = billing.reserveChannel({ requestId, channelId: channelB, amount: '5' });
      const toC = billing.reserveChannel({ requestId, channelId: channelC, amount: '5' });
      await new Promise((r) => setTimeout(r, 400));
      await blocker.query('COMMIT');
      blocker.release();

      const outcomes = await Promise.allSettled([toB, toC]);
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o) => o.status === 'rejected');
      // 恰好一笔成交；另一笔必须显式失败（释放守卫或认领 CAS 拦截——同一
      // 不变量的两层防线，具体哪层取决于交错顺序），不允许静默双成交
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(Error);

      // 【红】当前实现：两笔都成交——A 被释放两次（-5），B/C 各留 5 孤儿敞口
      // 【正确】A 恰好释放一次；B/C 有且仅有一个承接 5
      expect((await reservedOf(channelA)).toString()).toBe('0');
      const b = await reservedOf(channelB);
      const c = await reservedOf(channelC);
      expect(b.plus(c).toString()).toBe('5');
      expect(b.abs().lte(new Decimal(5)).toString()).toBe('true');
      expect(c.abs().lte(new Decimal(5)).toString()).toBe('true');

      const br = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.requestId, requestId),
        columns: { channelId: true, channelReservedAmount: true },
      });
      expect(new Decimal(br?.channelReservedAmount ?? '0').toString()).toBe('5');
      if (b.gt(0)) expect(br?.channelId).toBe(channelB);
      else expect(br?.channelId).toBe(channelC);
    } finally {
      await cleanup(userId, providerId, channelIds);
    }
  });
});
