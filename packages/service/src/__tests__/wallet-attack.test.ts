/**
 * wallet 攻击面矩阵（真实 PG）：金额形态/引用键形态全部结构性拒绝——
 * 任何异常输入都算不出错误金额（负/NaN/Infinity/科学计数法/超尺度/零额）。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { createDb } from '@ai-gateway/db';
import { users } from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import { InvalidAmountError, InvalidRefError } from '@ai-gateway/domain';
import { createWallet } from '../wallet/wallet.js';
import { systemContext, type RunContext } from '../context.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const ctx: RunContext = systemContext('v2wa-suite');
const wallet = createWallet({
  db,
  currency: 'CNY',
  guards: { refTypes: ['v2wa'], currencies: ['CNY'], internalAccounts: ['outside', 'platform_revenue'] },
});
const createdUsers: number[] = [];

async function newUser(): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ issuer: 'v2wa', subject: `v2wa-${randomUUID()}`, identityProvider: 'local' })
    .returning({ id: users.id });
  createdUsers.push(row!.id);
  return row!.id;
}

const rid = (tag: string): string => `v2wa-${tag}-${randomUUID().slice(0, 8)}`;

afterAll(async () => {
  if (createdUsers.length) await db.delete(users).where(inArray(users.id, createdUsers));
  await db.$client.end().catch(() => {});
});

describe('金额攻击面：四个动词同口径结构性拒绝', () => {
  const badAmounts = ['-1', '0', 'NaN', 'Infinity', '-Infinity', '1e-21', '0.1234567890123456789', '100000000000000000000'];
  const verbs = [
    { name: 'credit', run: (userId: number, amount: string, refId: string) =>
      wallet.credit(ctx, { userId, amount, refType: 'v2wa', refId }) },
    { name: 'authorize', run: (userId: number, amount: string, refId: string) =>
      wallet.authorize(ctx, { userId, amount, refType: 'v2wa', refId }) },
    { name: 'transfer', run: (userId: number, amount: string, refId: string) =>
      wallet.transfer(ctx, { from: { userId }, to: { code: 'outside' }, amount, refType: 'v2wa', refId, allowCredit: false }) },
    { name: 'refund', run: (userId: number, amount: string, refId: string) =>
      wallet.refund(ctx, { userId, amount, refType: 'v2wa', refId }) },
  ];

  for (const verb of verbs) {
    it(`${verb.name}：全部非法金额拒绝（${badAmounts.length} 形态）`, async () => {
      const user = await newUser();
      for (const amount of badAmounts) {
        await expect(verb.run(user, amount, rid('bad'))).rejects.toThrow(InvalidAmountError);
      }
    });
  }

  it('合法边界放行：18 位小数的最小金额可入账', async () => {
    const user = await newUser();
    const result = await wallet.credit(ctx, {
      userId: user, amount: '0.000000000000000001', refType: 'v2wa', refId: rid('min'),
    });
    expect(result.replayed).toBe(false);
  });
});

describe('引用键攻击面', () => {
  it('refId 空 / 超长（129）拒绝', async () => {
    const user = await newUser();
    await expect(
      wallet.credit(ctx, { userId: user, amount: '1', refType: 'v2wa', refId: '' }),
    ).rejects.toThrow(InvalidRefError);
    await expect(
      wallet.credit(ctx, { userId: user, amount: '1', refType: 'v2wa', refId: 'x'.repeat(129) }),
    ).rejects.toThrow(InvalidRefError);
  });

  it('未声明 refType / 币种 / 科目 fail-closed 拒绝', async () => {
    const user = await newUser();
    await expect(
      wallet.credit(ctx, { userId: user, amount: '1', refType: 'unknown', refId: rid('x') }),
    ).rejects.toThrow(InvalidRefError);
    await expect(
      wallet.credit(ctx, { userId: user, amount: '1', refType: 'v2wa', refId: rid('x'), currency: 'USD' }),
    ).rejects.toThrow(InvalidRefError);
    await expect(
      wallet.credit(ctx, { userId: user, amount: '1', refType: 'v2wa', refId: rid('x'), counterparty: 'evil' }),
    ).rejects.toThrow(InvalidRefError);
  });
});
