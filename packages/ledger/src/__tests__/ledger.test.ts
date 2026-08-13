import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { fundOperations, transactions, users } from '@ai-gateway/db/schema';
import { Decimal } from '@ai-gateway/money';
import { createLedger, LedgerError } from '../ledger.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
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

  it('negative adjustment cannot consume funds reserved by active requests', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('10');
    const ledger = createLedger({ db });
    try {
      await db.update(users).set({ reservedBalance: '8' }).where(eq(users.id, userId));
      await expect(
        ledger.adminAdjust({
          operationId: `adjust-too-much:${userId}`,
          userId,
          amount: '-3',
          adminId: null,
        }),
      ).rejects.toMatchObject({ code: 'insufficient_balance' } satisfies Partial<LedgerError>);
      const applied = await ledger.adminAdjust({
        operationId: `adjust-available:${userId}`,
        userId,
        amount: '-2',
        adminId: null,
      });
      expect(applied.balanceAfter).toBe('8.000000000000000000');
      const user = await db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { balance: true, reservedBalance: true },
      });
      expect(user).toMatchObject({
        balance: '8.000000000000000000',
        reservedBalance: '8.000000000000000000',
      });
    } finally {
      await db
        .delete(fundOperations)
        .where(eq(fundOperations.operationId, `adjust-too-much:${userId}`));
      await db
        .delete(fundOperations)
        .where(eq(fundOperations.operationId, `adjust-available:${userId}`));
      await cleanup(userId);
    }
  });
});
