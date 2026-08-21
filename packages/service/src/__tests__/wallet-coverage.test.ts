/**
 * wallet 覆盖面对账（真实 PG）：statement 分页游标 / 多币种并存 / 信用-现金双口径矩阵 /
 * 过期冻结单不可结算（老 production-contract 的权威语义）。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { createDb } from '@ai-gateway/db';
import { users } from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import {
  AuthorizationNotActiveError,
  InsufficientBalanceError,
  InsufficientCashError,
} from '@ai-gateway/domain';
import { createWallet } from '../wallet/wallet.js';
import { systemContext, type RunContext } from '../context.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const ctx: RunContext = systemContext('v2wc-suite');
const wallet = createWallet({
  db,
  currency: 'CNY',
  guards: {
    refTypes: ['v2wc'],
    currencies: ['CNY', 'USD'],
    internalAccounts: ['outside', 'platform_revenue'],
  },
});
const createdUsers: number[] = [];

async function newUser(): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ issuer: 'v2wc', subject: `v2wc-${randomUUID()}`, identityProvider: 'local' })
    .returning({ id: users.id });
  createdUsers.push(row!.id);
  return row!.id;
}

const rid = (tag: string): string => `v2wc-${tag}-${randomUUID().slice(0, 8)}`;

afterAll(async () => {
  if (createdUsers.length) await db.delete(users).where(inArray(users.id, createdUsers));
  await db.$client.end().catch(() => {});
});

describe('statement 分页（腿级游标）', () => {
  it('limit 分页 + beforeLegId 游标连续翻页 + kinds 过滤', async () => {
    const user = await newUser();
    for (let i = 0; i < 5; i++) {
      await wallet.credit(ctx, { userId: user, amount: '1', refType: 'v2wc', refId: rid(`p${i}`), memo: `p${i}` });
    }
    const page1 = await wallet.statement(ctx, { userId: user, limit: 2 });
    expect(page1).toHaveLength(2);
    const page2 = await wallet.statement(ctx, { userId: user, limit: 2, beforeLegId: page1[1]!.legId });
    expect(page2).toHaveLength(2);
    const page3 = await wallet.statement(ctx, { userId: user, limit: 2, beforeLegId: page2[1]!.legId });
    expect(page3).toHaveLength(1);
    // id 倒序连续
    expect(page1[0]!.legId).toBeGreaterThan(page1[1]!.legId);
    expect(page1[1]!.legId).toBeGreaterThan(page2[0]!.legId);
    // kinds 过滤
    const holdRef = rid('hold-kinds');
    await wallet.credit(ctx, { userId: user, amount: '2', refType: 'v2wc', refId: rid('f2') });
    await wallet.authorize(ctx, { userId: user, amount: '1', refType: 'v2wc', refId: holdRef });
    const onlyCredit = await wallet.statement(ctx, { userId: user, kinds: ['credit'] });
    expect(onlyCredit.every((item) => item.transactionKind === 'credit')).toBe(true);
    expect(onlyCredit.length).toBeGreaterThanOrEqual(6);
  });
});

describe('多币种账户并存', () => {
  it('CNY 与 USD 独立记账：余额/在途互不串账', async () => {
    const user = await newUser();
    await wallet.credit(ctx, { userId: user, amount: '10', refType: 'v2wc', refId: rid('cny'), currency: 'CNY' });
    await wallet.credit(ctx, { userId: user, amount: '5', refType: 'v2wc', refId: rid('usd'), currency: 'USD' });
    const summaries = await wallet.accounts(ctx, user);
    expect(summaries).toHaveLength(2);
    const byCurrency = new Map(summaries.map((s) => [s.currency, s]));
    expect(byCurrency.get('CNY')!.balance).toBe('10');
    expect(byCurrency.get('USD')!.balance).toBe('5');
    // USD 冻结不侵占 CNY 可用
    await wallet.authorize(ctx, { userId: user, amount: '4', refType: 'v2wc', refId: rid('usd-hold'), currency: 'USD' });
    const after = await wallet.accounts(ctx, user);
    const usd = after.find((s) => s.currency === 'USD')!;
    const cny = after.find((s) => s.currency === 'CNY')!;
    expect(usd.inFlight).toBe('4');
    expect(cny.inFlight).toBe('0');
    expect(cny.balance).toBe('10');
  });
});

describe('信用 / 现金双口径矩阵', () => {
  it('现金口径：授信不参与可用额（余额 1 + 授信 5，扣 2 → InsufficientCash）', async () => {
    const user = await newUser();
    await wallet.credit(ctx, { userId: user, amount: '1', refType: 'v2wc', refId: rid('f') });
    await wallet.setCreditLimit(ctx, { userId: user, amount: '5', refType: 'v2wc', refId: rid('cl') });
    await expect(
      wallet.transfer(ctx, {
        from: { userId: user }, to: { code: 'platform_revenue' },
        amount: '2', refType: 'v2wc', refId: rid('cash'), currency: 'CNY', allowCredit: false,
      }),
    ).rejects.toThrow(InsufficientCashError);
  });

  it('信用口径：同一笔放行到授信地板（透支记账）', async () => {
    const user = await newUser();
    await wallet.credit(ctx, { userId: user, amount: '1', refType: 'v2wc', refId: rid('f') });
    await wallet.setCreditLimit(ctx, { userId: user, amount: '5', refType: 'v2wc', refId: rid('cl') });
    const result = await wallet.transfer(ctx, {
      from: { userId: user }, to: { code: 'platform_revenue' },
      amount: '2', refType: 'v2wc', refId: rid('credit'), currency: 'CNY',
    });
    expect(result.fromBalanceAfter).toBe('-1');
  });

  it('双口径都不足 → InsufficientBalance（信用口径上限）', async () => {
    const user = await newUser();
    await wallet.credit(ctx, { userId: user, amount: '1', refType: 'v2wc', refId: rid('f') });
    await expect(
      wallet.transfer(ctx, {
        from: { userId: user }, to: { code: 'platform_revenue' },
        amount: '7', refType: 'v2wc', refId: rid('over'), currency: 'CNY', // 1 + 授信 0 = 1
      }),
    ).rejects.toThrow(InsufficientBalanceError);
  });
});

describe('expiresAt：结算的权威截止时间', () => {
  it('过期冻结单不可结算（AuthorizationNotActive/expired）；未过期可结算', async () => {
    const user = await newUser();
    await wallet.credit(ctx, { userId: user, amount: '5', refType: 'v2wc', refId: rid('f') });
    const expiredRef = rid('expired');
    await wallet.authorize(ctx, {
      userId: user, amount: '1', refType: 'v2wc', refId: expiredRef,
      expiresAt: new Date(Date.now() - 1_000),
    });
    await expect(
      wallet.settle(ctx, { refType: 'v2wc', refId: expiredRef, amount: '0.5' }),
    ).rejects.toThrow(AuthorizationNotActiveError);

    const aliveRef = rid('alive');
    await wallet.authorize(ctx, {
      userId: user, amount: '1', refType: 'v2wc', refId: aliveRef,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      wallet.settle(ctx, { refType: 'v2wc', refId: aliveRef, amount: '0.5' }),
    ).resolves.toMatchObject({ replayed: false });
  });
});
