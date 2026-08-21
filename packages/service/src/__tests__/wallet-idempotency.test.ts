/**
 * 幂等竞态矩阵（真实 PG）：并发同键触发唯一冲突兜底路径——
 * 输家必须拿到重放首答而不是报错；顺序重放返回全等首答。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { createDb } from '@ai-gateway/db';
import { users } from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import { createWallet } from '../wallet/wallet.js';
import { systemContext, type RunContext } from '../context.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 8 },
);
const ctx: RunContext = systemContext('v2wi-suite');
const wallet = createWallet({
  db,
  currency: 'CNY',
  guards: { refTypes: ['v2wi'], currencies: ['CNY'], internalAccounts: ['outside', 'platform_revenue'] },
});
const createdUsers: number[] = [];

async function newUser(): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ issuer: 'v2wi', subject: `v2wi-${randomUUID()}`, identityProvider: 'local' })
    .returning({ id: users.id });
  createdUsers.push(row!.id);
  return row!.id;
}

const rid = (tag: string): string => `v2wi-${tag}-${randomUUID().slice(0, 8)}`;

async function balanceOf(userId: number): Promise<{ balance: string; inFlight: string }> {
  const rows = await wallet.accounts(ctx, userId);
  const account = rows[0]!;
  return { balance: account.balance, inFlight: account.inFlight };
}

afterAll(async () => {
  if (createdUsers.length) await db.delete(users).where(inArray(users.id, createdUsers));
  await db.$client.end().catch(() => {});
});

describe('并发同键竞态：唯一冲突兜底重放', () => {
  it('credit：双发同键一成一重放，余额只加一次', async () => {
    const user = await newUser();
    const refId = rid('credit-race');
    const results = await Promise.allSettled([
      wallet.credit(ctx, { userId: user, amount: '5', refType: 'v2wi', refId }),
      wallet.credit(ctx, { userId: user, amount: '5', refType: 'v2wi', refId }),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const values = results.map((r) => (r as PromiseFulfilledResult<{ replayed: boolean; transactionId: number }>).value);
    expect(values.some((v) => !v.replayed)).toBe(true);
    expect(values.some((v) => v.replayed)).toBe(true);
    expect(new Set(values.map((v) => v.transactionId)).size).toBe(1);
    expect((await balanceOf(user)).balance).toBe('5');
  });

  it('authorize：双发同键只冻一次', async () => {
    const user = await newUser();
    await wallet.credit(ctx, { userId: user, amount: '5', refType: 'v2wi', refId: rid('f') });
    const refId = rid('hold-race');
    await Promise.all([
      wallet.authorize(ctx, { userId: user, amount: '2', refType: 'v2wi', refId }),
      wallet.authorize(ctx, { userId: user, amount: '2', refType: 'v2wi', refId }),
    ]);
    expect((await balanceOf(user)).inFlight).toBe('2');
  });

  it('settle：双发同键一实扣一重放首答', async () => {
    const user = await newUser();
    await wallet.credit(ctx, { userId: user, amount: '5', refType: 'v2wi', refId: rid('f') });
    const refId = rid('settle-race');
    await wallet.authorize(ctx, { userId: user, amount: '2', refType: 'v2wi', refId });
    const results = await Promise.allSettled([
      wallet.settle(ctx, { refType: 'v2wi', refId, amount: '1.2' }),
      wallet.settle(ctx, { refType: 'v2wi', refId, amount: '1.2' }),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const values = results.map((r) => (r as PromiseFulfilledResult<{ replayed: boolean; balanceAfter: string }>).value);
    expect(new Set(values.map((v) => v.balanceAfter)).size).toBe(1);
    const after = await balanceOf(user);
    expect(after.balance).toBe('3.8'); // 5 − 1.2 实扣一次
    expect(after.inFlight).toBe('0');
  });
});

describe('顺序重放：首答全等', () => {
  it('credit 重放各字段与首答一致', async () => {
    const user = await newUser();
    const refId = rid('replay-eq');
    const first = await wallet.credit(ctx, { userId: user, amount: '3.3', refType: 'v2wi', refId });
    const replay = await wallet.credit(ctx, { userId: user, amount: '3.3', refType: 'v2wi', refId });
    expect(replay).toMatchObject({
      transactionId: first.transactionId,
      amount: first.amount,
      balanceAfter: first.balanceAfter,
      replayed: true,
    });
  });
});
