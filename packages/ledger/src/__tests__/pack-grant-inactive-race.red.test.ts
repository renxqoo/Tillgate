import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import {
  fundOperations,
  plans,
  transactions,
  users,
  userSubscriptions,
} from '@ai-gateway/db/schema';
import { Decimal } from '@ai-gateway/money';
import { createLedger } from '../index.js';

/**
 * 红测（P1-3）：grantPack 选订阅无行锁、额度 UPDATE 无 status 守卫。
 *
 * 竞态交错：grantPack 无锁读到有效订阅（status=0）→ 并发取消/变更把该行置
 * status=1 并提交 → grantPack 的 quotaAmount += x 只按 id 命中失效行并提交。
 * 结果：用户付了售价，额度却加到已被替换/取消的死订阅上（资损）。
 * 修法：选订阅行 FOR UPDATE（与取消/变更的行写互斥），额度 UPDATE 带
 * status=0 条件并校验 returning 非空——0 行命中抛 subscription_inactive。
 */

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
afterAll(async () => db.$client.end().catch(() => {}));

const PREFIX = 'p1led-pack-race';

async function cleanup(userId: number): Promise<void> {
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(userSubscriptions).where(eq(userSubscriptions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

describe('grantPack 订阅失效竞态（P1-3 红测）', () => {
  it('读订阅与加额度之间订阅被并发取消 → 必须拒绝，不得把额度加到失效订阅', async (context) => {
    if (!connected) return context.skip();
    const [user] = await db
      .insert(users)
      .values({
        issuer: 'test',
        subject: `${PREFIX}-${randomUUID()}`,
        identityProvider: 'local',
        balance: '100',
      })
      .returning({ id: users.id });
    const userId = user!.id;
    const [pack] = await db
      .insert(plans)
      .values({
        name: `${PREFIX}-pack-${randomUUID().slice(0, 6)}`,
        price: '10',
        periodDays: 30,
        quotaAmount: '15',
        status: 0,
        kind: 'pack',
        sortOrder: null,
      })
      .returning({ id: plans.id });
    const packId = pack!.id;
    const [sub] = await db
      .insert(userSubscriptions)
      .values({
        userId,
        planId: packId,
        startAt: new Date(Date.now() - 1000),
        endAt: new Date(Date.now() + 86_400_000),
        quotaAmount: '50',
        usedAmount: '0',
        reservedAmount: '0',
        quantity: 1,
        price: '50',
        status: 0,
      })
      .returning({ id: userSubscriptions.id });
    const subscriptionId = sub!.id;
    const ledger = createLedger({ db });
    const operationId = `${PREFIX}-${randomUUID()}`;

    try {
      // tx1：模拟并发取消/变更——行锁持有期间不提交（status 置 1）
      let commitTx1!: () => void;
      const holdGate = new Promise<void>((resolve) => {
        commitTx1 = resolve;
      });
      const tx1 = db.transaction(async (tx) => {
        await tx
          .update(userSubscriptions)
          .set({ status: 1 })
          .where(eq(userSubscriptions.id, subscriptionId));
        await holdGate; // 行锁挂起，制造「grantPack 读到 status=0 + 写时才撞锁」窗口
      });
      await new Promise((r) => setTimeout(r, 150)); // 确保 tx1 已持有行锁

      const grantPromise = ledger.grantPack({ operationId, userId, packId });
      // 等 grantPack 走完读（红阶段必然读到 status=0），在额度 UPDATE 上阻塞
      await new Promise((r) => setTimeout(r, 500));

      commitTx1();
      await tx1;
      // 订阅已被并发替换/取消：加油包必须被拒绝（LedgerError），而非静默入账
      await expect(grantPromise).rejects.toMatchObject({
        name: 'LedgerError',
        code: expect.stringMatching(/^(no_subscription|subscription_inactive)$/),
      });

      // 失效订阅额度不得被加包：仍是 50；余额未被扣：仍是 100
      const subRow = await db.query.userSubscriptions.findFirst({
        where: eq(userSubscriptions.id, subscriptionId),
      });
      expect(subRow!.status).toBe(1);
      expect(new Decimal(subRow!.quotaAmount).eq(50)).toBe(true);
      const userRow = await db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { balance: true },
      });
      expect(new Decimal(userRow!.balance).eq(100)).toBe(true);
      const packTx = await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(eq(transactions.userId, userId));
      expect(packTx).toHaveLength(0);
    } finally {
      await db.delete(fundOperations).where(eq(fundOperations.operationId, operationId));
      await cleanup(userId);
    }
  });
});
