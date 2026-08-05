import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { eq, sql } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { users, usageLogs, transactions } from '@ai-gateway/db/schema';
import { Decimal, calcHold, estimateMaxCost, toDecimal } from '@ai-gateway/money';
import { BillingService } from './billing.js';
import { syncSettle, type SyncSettleData } from './sync-settle.js';

/**
 * 允许负余额模型 — 端到端链路自洽性（重构后：元 + decimal + DB 行锁）。
 *
 * 链路：透支→负余额→下次请求 hold 被拦→充值恢复→重新放行。
 *
 * 价格：input 1000 元/M、output 2000 元/M；usage 1000+500 → amount = 2 元。
 */

const cwd = dirname(fileURLToPath(import.meta.url));
function loadEnvFile(): void {
  let dir = cwd;
  for (let i = 0; i < 6; i++) {
    const f = resolve(dir, '.env');
    if (existsSync(f)) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
        if (m && m[1] && !(m[1] in process.env)) process.env[m[1]] = m[2];
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
loadEnvFile();

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const db: Db = createDb(DATABASE_URL);
const redis = new Redis(REDIS_URL, { retryStrategy: () => null, lazyConnect: true, maxRetriesPerRequest: null });

let connected = false;
beforeAll(async () => {
  try {
    await redis.connect();
    await db.query.users.findFirst({ where: eq(users.id, 1), columns: { id: true } });
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => {
  await redis.quit().catch(() => {});
  await db.$client.end().catch(() => {});
});

async function createTestUser(balance: string): Promise<number> {
  const [u] = await db.insert(users).values({
    issuer: 'test',
    subject: 'negbal-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    identityProvider: 'local',
    displayName: 'NegBalance E2E',
    balance,
  }).returning();
  return u!.id;
}
async function cleanupUser(userId: number): Promise<void> {
  await db.delete(usageLogs).where(eq(usageLogs.userId, userId));
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
  await redis.del(`billing:balance:${userId}`).catch(() => {});
}

function makeData(userId: number, requestId: string): SyncSettleData {
  return {
    apiKeyId: null, appId: null, credentialType: 'key',
    externalModel: 'm', realModel: 'r', channelId: null,
    usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 500, estimated: false },
    inputPrice: '1000', outputPrice: '2000', cacheInputPrice: '100',
    coefficient: '1.0', durationMs: 100,
    stream: false, streamAborted: false, holdAmount: '0', mappingId: 1,
    userId, requestId,
  };
}

function expectDec(actual: string | undefined, expected: string): void {
  expect(new Decimal(actual ?? '0').toString()).toBe(new Decimal(expected).toString());
}

describe('允许负余额模型 — 端到端链路自洽性（DB 行锁，元 + decimal）', () => {
  it('透支→负余额→下次请求被拦→充值恢复→重新放行（全链路）', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser('1'); // 余额 1 元
    const billing = new BillingService(redis, db, 600_000);
    try {
      // === 1. 透支：余额 1，费用 2 → 扣成 -1 ===
      const r = await syncSettle(db, makeData(userId, randomUUID()));
      expect(r.settled).toBe(true);
      expect(r.overdraft).toBe(true);
      const u1 = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { balance: true } });
      expectDec(u1?.balance, '-1');

      // === 2. getBalance 读到负数（DB 权威，无缓存）===
      const balanceAfterOverdraft = await billing.getBalance(userId);
      expectDec(balanceAfterOverdraft, '-1');

      // === 3. calcHold(estimate, 负余额, max) → 0 ===
      const estimate = estimateMaxCost({
        estimatedInputTokens: 2000, maxOutputTokens: 1000,
        inputPrice: '1000', outputPrice: '2000', coefficient: '1.0',
      });
      expect(estimate.gt(0)).toBe(true);
      const holdAmount = calcHold(estimate, toDecimal(balanceAfterOverdraft), 50);
      expect(holdAmount.isZero()).toBe(true); // 负余额 → calcHold 返回 0

      // === 4. 路由层守卫 holdAmount=0 && balance<=0 → 应拦截 ===
      expect(holdAmount.isZero() && toDecimal(balanceAfterOverdraft).lte(0)).toBe(true);

      // === 5. BillingService.hold 对负余额 → DB 条件 UPDATE 返回空 → ok=false, insufficient ===
      const holdRes = await billing.hold(userId, randomUUID(), '0.5');
      expect(holdRes.ok).toBe(false);
      expect(holdRes.reason).toBe('insufficient');

      // === 6. 充值 3 → 余额 -1+3=2（自动抵扣欠款）===
      await db.update(users)
        .set({ balance: sql`${users.balance} + 3::numeric`, updatedAt: new Date() })
        .where(eq(users.id, userId));
      const balanceAfterRecharge = await billing.getBalance(userId);
      expectDec(balanceAfterRecharge, '2');

      // === 7. 充值后 calcHold 放行，hold 成功 ===
      const holdAmount2 = calcHold(estimate, toDecimal(balanceAfterRecharge), 50);
      expect(holdAmount2.gt(0)).toBe(true);
      const holdRes2 = await billing.hold(userId, randomUUID(), holdAmount2);
      expect(holdRes2.ok).toBe(true);
    } finally {
      await cleanupUser(userId);
    }
  });

  it('正常余额用户：hold 成功 → syncSettle 结算 → 余额准确（对照组）', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser('100'); // 余额 100 元
    const billing = new BillingService(redis, db, 600_000);
    try {
      const balance = await billing.getBalance(userId);
      expectDec(balance, '100');
      const holdRes = await billing.hold(userId, randomUUID(), '2');
      expect(holdRes.ok).toBe(true);
      await syncSettle(db, makeData(userId, randomUUID()));
      const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { balance: true } });
      // 100 - 2(hold) - 2(settle 实际) = 96
      // 注：hold 在 DB 扣 2，settle 又在 DB 扣实际 2（hold 不抵扣），故 100-2-2=96
      expectDec(u?.balance, '96');
    } finally {
      await cleanupUser(userId);
    }
  });
});
