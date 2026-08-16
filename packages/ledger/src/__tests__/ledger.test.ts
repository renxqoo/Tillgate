import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { fundOperations, transactions, users } from '@ai-gateway/db/schema';
import { Decimal } from '@ai-gateway/money';
import { createLedger, LedgerError } from '../ledger.js';

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

afterAll(async () => {
  await db.$client.end().catch(() => {});
});

async function createUser(balance = '0'): Promise<number> {
  const [user] = await db
    .insert(users)
    .values({
      issuer: 'test',
      subject: `ledger-boundary-${randomUUID()}`,
      identityProvider: 'local',
      balance,
    })
    .returning({ id: users.id });
  return user!.id;
}

async function cleanup(userId: number): Promise<void> {
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(fundOperations).where(eq(fundOperations.operationId, `gift:${userId}`));
  await db.delete(users).where(eq(users.id, userId));
}

describe('Ledger public boundary', () => {
  it('adminGift atomically changes balance and writes one replayable transaction', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser();
    const operationId = `gift:${userId}`;
    const ledger = createLedger({ db });
    try {
      const first = await ledger.adminGift({
        operationId,
        userId,
        amount: '10.25',
        adminId: null,
      });
      const replay = await ledger.adminGift({
        operationId,
        userId,
        amount: '10.25',
        adminId: null,
      });
      expect(first.replayed).toBe(false);
      expect(replay.replayed).toBe(true);
      expect(replay.transactionId).toBe(first.transactionId);
      expect(new Decimal(await ledger.getBalance(userId)).eq('10.25')).toBe(true);
      const rows = await db.select().from(transactions).where(eq(transactions.userId, userId));
      expect(rows).toHaveLength(1);
    } finally {
      await cleanup(userId);
    }
  });

  it('same operation id with a different amount is rejected', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser();
    const operationId = `gift:${userId}`;
    const ledger = createLedger({ db });
    try {
      await ledger.adminGift({ operationId, userId, amount: '1', adminId: null });
      await expect(
        ledger.adminGift({ operationId, userId, amount: '2', adminId: null }),
      ).rejects.toMatchObject({ code: 'idempotency_conflict' } satisfies Partial<LedgerError>);
      expect(new Decimal(await ledger.getBalance(userId)).eq('1')).toBe(true);
    } finally {
      await cleanup(userId);
    }
  });

  it('信用模型：负向调账受 credit_limit 约束，balance 可负到 -credit_limit，不受在途敞口约束', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('10');
    await db.update(users).set({ creditLimit: '5' }).where(eq(users.id, userId));
    const ledger = createLedger({ db });
    try {
      // 在途敞口(reserved)不是冻结，不影响负向调账；balance 允许扣到 -credit_limit(-5)。
      await db.update(users).set({ reservedBalance: '8' }).where(eq(users.id, userId));
      const applied = await ledger.adminAdjust({
        operationId: `adjust-neg:${userId}`,
        userId,
        amount: '-14',
        adminId: null,
      });
      expect(applied.balanceAfter).toBe('-4.000000000000000000'); // 10 - 14 = -4 >= -5
      // 再扣会跌破 -credit_limit → 拒绝
      await expect(
        ledger.adminAdjust({
          operationId: `adjust-over:${userId}`,
          userId,
          amount: '-2',
          adminId: null,
        }),
      ).rejects.toMatchObject({ code: 'insufficient_balance' } satisfies Partial<LedgerError>);
    } finally {
      await db.delete(fundOperations).where(eq(fundOperations.operationId, `adjust-neg:${userId}`));
      await db.delete(fundOperations).where(eq(fundOperations.operationId, `adjust-over:${userId}`));
      await cleanup(userId);
    }
  });
});
