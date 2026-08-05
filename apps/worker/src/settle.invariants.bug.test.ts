import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { eq, sql } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { users, usageLogs, transactions } from '@ai-gateway/db/schema';
import { Decimal } from '@ai-gateway/money';
import { settle, type MeterJobData } from './settle.js';

/**
 * 透支账务模型测试（重构后：元 + decimal 全精度）。
 * 业务模型：上游已执行 → 如实扣全额 amount，余额可为负（欠款），下次充值抵扣。
 * 对账不变量：usage_logs.status=0；consume 流水 amount = balanceBefore - balanceAfter。
 *
 * 价格：input 1000 元/M、output 2000 元/M（=旧 1e6/2e6 厘/M ÷1000）。
 * usage 1000 输入 + 500 输出 → amount = (1000×1000 + 500×2000)/1e6 = 2 元。
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
    subject: 'invariant-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    identityProvider: 'local',
    displayName: 'Invariant Test',
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

function makeJob(overrides: Partial<MeterJobData> & { userId: number; requestId: string }): MeterJobData {
  return {
    apiKeyId: null, appId: null, credentialType: 'key',
    externalModel: 'test-model', realModel: 'test-real', channelId: null,
    usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 500, estimated: false },
    inputPrice: '1000', outputPrice: '2000', cacheInputPrice: '100',
    coefficient: '1.0', durationMs: 100,
    stream: false, streamAborted: false, holdAmount: '0', mappingId: 1,
    ...overrides,
  };
}

function expectDec(actual: string | undefined, expected: string): void {
  expect(new Decimal(actual ?? '0').toString()).toBe(new Decimal(expected).toString());
}

describe('透支允许负余额模型（元 + decimal，对账不变量成立）', () => {
  it('透支：余额 1 扣 2 → 余额变 -1（如实扣，不为负守卫拦截）', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser('1');
    try {
      const job = makeJob({ userId, requestId: randomUUID() });
      const r = await settle(db, redis, job);
      expectDec(r.amount, '2');
      expect(r.settled).toBe(true);
      expect(r.overdraft).toBe(true);
      const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { balance: true } });
      expectDec(u?.balance, '-1'); // 1 - 2 = -1
    } finally {
      await cleanupUser(userId);
    }
  });

  it('透支时 usage_logs.status = 0（成功已计费，如实记录）', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser('1');
    try {
      const job = makeJob({ userId, requestId: randomUUID() });
      await settle(db, redis, job);
      const log = await db.query.usageLogs.findFirst({ where: eq(usageLogs.requestId, job.requestId) });
      expect(log?.status).toBe(0);
      expectDec(log?.amount, '2');
      expectDec(log?.paygAmount, '2');
    } finally {
      await cleanupUser(userId);
    }
  });

  it('对账不变量：透支时 consume 流水 |Δbalance| == |amount|', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser('1');
    try {
      const job = makeJob({ userId, requestId: randomUUID() });
      await settle(db, redis, job);
      const txs = await db.select().from(transactions).where(eq(transactions.refId, job.requestId));
      const consumeTx = txs.find((t) => t.type === 'consume');
      expect(consumeTx).toBeDefined();
      const delta = new Decimal(consumeTx!.balanceBefore).minus(consumeTx!.balanceAfter);
      expect(delta.abs().toString()).toBe(new Decimal(consumeTx!.amount).abs().toString()); // 2 == 2
      expectDec(consumeTx!.balanceBefore, '1');
      expectDec(consumeTx!.balanceAfter, '-1');
    } finally {
      await cleanupUser(userId);
    }
  });

  it('债务偿还：透支成 -1 后充值 3 → 余额变 2（自动抵扣欠款）', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser('1');
    try {
      await settle(db, redis, makeJob({ userId, requestId: randomUUID() }));
      const afterOverdraft = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { balance: true } });
      expectDec(afterOverdraft?.balance, '-1');

      // 充值 3 元（模拟充值码：balance += 3）
      await db.update(users)
        .set({ balance: sql`${users.balance} + 3::numeric`, updatedAt: new Date() })
        .where(eq(users.id, userId));
      const afterRecharge = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { balance: true } });
      expectDec(afterRecharge?.balance, '2'); // -1 + 3 = 2
    } finally {
      await cleanupUser(userId);
    }
  });

  it('正常计费行满足对账不变量（对照组）', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser('10');
    try {
      const job = makeJob({ userId, requestId: randomUUID() });
      const r = await settle(db, redis, job);
      expect(r.overdraft).toBe(false);
      const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { balance: true } });
      expectDec(u?.balance, '8'); // 10 - 2
      const txs = await db.select().from(transactions).where(eq(transactions.refId, job.requestId));
      const consumeTx = txs.find((t) => t.type === 'consume');
      expect(consumeTx).toBeDefined();
      const delta = new Decimal(consumeTx!.balanceBefore).minus(consumeTx!.balanceAfter);
      expect(delta.abs().toString()).toBe(new Decimal(consumeTx!.amount).abs().toString());
    } finally {
      await cleanupUser(userId);
    }
  });
});
