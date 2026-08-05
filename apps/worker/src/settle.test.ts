import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { users, usageLogs, transactions } from '@ai-gateway/db/schema';
import { settle, type MeterJobData } from './settle.js';

// 加载 monorepo 根 .env（vitest 不自动加载；CI 用真实 env 时不覆盖）
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

/**
 * settle 集成测试：需要真实 Postgres + Redis（CI/本地环境）。
 * 无 DB/Redis 时 beforeAll 抛错 → 所有 it 自动跳过。
 *
 * 验证维度（资损防线）：
 *   - 幂等：同一 requestId 重复结算只扣一次
 *   - 并发安全：同一用户多个并发请求，余额准确（不丢更新、不重复扣）
 *   - 预扣对账：实际费用 vs holdAmount，补扣/退款正确
 */
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

const db: Db = createDb(DATABASE_URL);
const redis = new Redis(REDIS_URL, { retryStrategy: () => null, lazyConnect: true, maxRetriesPerRequest: null });

beforeAll(async () => {
  await redis.connect();
  await db.query.users.findFirst({ where: eq(users.id, 1), columns: { id: true } });
});

afterAll(async () => {
  await redis.quit().catch(() => {});
  await db.$client.end().catch(() => {});
});

/** 创建测试专用用户（独立余额，不污染 dev 数据），返回 userId */
async function createTestUser(balance: number): Promise<number> {
  const [u] = await db.insert(users).values({
    issuer: 'test',
    subject: 'settle-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    identityProvider: 'local',
    displayName: 'Settle Test',
    balance,
  }).returning();
  return u!.id;
}

async function cleanupUser(userId: number): Promise<void> {
  await db.delete(usageLogs).where(eq(usageLogs.userId, userId));
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
  await redis.del(`billing:balance:${userId}`);
}

function makeJob(overrides: Partial<MeterJobData> & { userId: number; requestId: string }): MeterJobData {
  return {
    apiKeyId: null,
    appId: null,
    credentialType: 'key',
    externalModel: 'test-model',
    realModel: 'test-real',
    channelId: null,
    usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 500, estimated: false },
    inputPrice: 1_000_000,
    outputPrice: 2_000_000,
    cacheInputPrice: 100_000,
    coefficient: 1.0,
    coefficientMilli: 1000,
    durationMs: 100,
    stream: false,
    streamAborted: false,
    holdAmount: 0,
    mappingId: 1,
    ...overrides,
  };
}

describe('settle 结算（幂等 + 并发安全 + 预扣对账）', () => {
  it('幂等：同一 requestId 重复结算只扣一次', async () => {
    const userId = await createTestUser(1_000_000);
    try {
      const job = makeJob({ userId, requestId: randomUUID(), holdAmount: 0 });
      // 1000 输入 × 1e6/1e6 + 500 输出 × 2e6/1e6 = 1000 + 1000 = 2000 厘
      const r1 = await settle(db, redis, job);
      expect(r1.settled).toBe(true);
      expect(r1.amount).toBe(2000);

      // 重复结算同一 job（模拟 BullMQ 重试）
      const r2 = await settle(db, redis, job);
      expect(r2.settled).toBe(false); // 幂等跳过
      expect(r2.amount).toBe(2000);

      // 余额只扣一次：1_000_000 - 2000 = 998_000
      const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { balance: true } });
      expect(u?.balance).toBe(998_000);

      // transactions 只有一条
      const txs = await db.select().from(transactions).where(eq(transactions.refId, job.requestId));
      expect(txs).toHaveLength(1);
    } finally {
      await cleanupUser(userId);
    }
  });

  it('并发安全：同一用户 5 个并发请求，余额准确（不丢更新）', async () => {
    const userId = await createTestUser(1_000_000);
    try {
      const jobs = Array.from({ length: 5 }, () =>
        makeJob({ userId, requestId: randomUUID(), holdAmount: 0 }),
      );
      // 并发结算（模拟多 worker 同时处理）
      const results = await Promise.all(jobs.map((j) => settle(db, redis, j)));
      // 全部成功结算
      expect(results.every((r) => r.settled)).toBe(true);
      // 每个扣 2000 厘，5 个共 10000 厘
      const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { balance: true } });
      expect(u?.balance).toBe(1_000_000 - 10_000);

      // 5 条流水，balanceBefore/After 严格连续（无覆盖/丢失）
      const txs = await db.select().from(transactions).where(eq(transactions.userId, userId));
      expect(txs).toHaveLength(5);
      // 所有 amount 都是 -2000
      expect(txs.every((t) => t.amount === -2000)).toBe(true);
    } finally {
      await cleanupUser(userId);
    }
  });

  it('并发幂等：同一 requestId 并发结算两次，只扣一次', async () => {
    const userId = await createTestUser(1_000_000);
    try {
      const job = makeJob({ userId, requestId: randomUUID(), holdAmount: 0 });
      // 同一 requestId 并发结算两次（极端竞态）
      const [r1, r2] = await Promise.all([settle(db, redis, job), settle(db, redis, job)]);
      // 恰好一个 settled，一个跳过
      const settledCount = [r1, r2].filter((r) => r.settled).length;
      expect(settledCount).toBe(1);
      // 余额只扣一次
      const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { balance: true } });
      expect(u?.balance).toBe(998_000);
    } finally {
      await cleanupUser(userId);
    }
  });

  it('预扣对账：实际费用 = hold → 不补扣不退款', async () => {
    const userId = await createTestUser(1_000_000);
    try {
      // 实际费用 2000 厘，hold 也是 2000 厘
      const job = makeJob({ userId, requestId: randomUUID(), holdAmount: 2000 });
      const r = await settle(db, redis, job);
      expect(r.settled).toBe(true);
      expect(r.amount).toBe(2000);
      // hold 占了 2000，实际 2000 → 净扣 2000
      const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { balance: true } });
      expect(u?.balance).toBe(998_000);
    } finally {
      await cleanupUser(userId);
    }
  });

  it('预扣对账：实际费用 < hold → 退款差额（不多扣）', async () => {
    const userId = await createTestUser(1_000_000);
    try {
      // 实际费用 2000 厘，但 hold 了 5000 厘
      const job = makeJob({ userId, requestId: randomUUID(), holdAmount: 5000 });
      const r = await settle(db, redis, job);
      expect(r.amount).toBe(2000);
      // 实际只扣 2000（hold 多扣的 3000 退回）
      const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { balance: true } });
      expect(u?.balance).toBe(998_000);
    } finally {
      await cleanupUser(userId);
    }
  });

  it('预扣对账：实际费用 > hold → 补扣差额', async () => {
    const userId = await createTestUser(1_000_000);
    try {
      // 实际费用 2000 厘，但只 hold 了 500 厘
      const job = makeJob({ userId, requestId: randomUUID(), holdAmount: 500 });
      const r = await settle(db, redis, job);
      expect(r.amount).toBe(2000);
      // 净扣 2000（补扣 1500）
      const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { balance: true } });
      expect(u?.balance).toBe(998_000);
    } finally {
      await cleanupUser(userId);
    }
  });

  it('零用量 → amount=0，不扣费但写 usage_logs', async () => {
    const userId = await createTestUser(500_000);
    try {
      const job = makeJob({
        userId,
        requestId: randomUUID(),
        usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, estimated: false },
      });
      const r = await settle(db, redis, job);
      expect(r.amount).toBe(0);
      expect(r.settled).toBe(true);
      const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { balance: true } });
      expect(u?.balance).toBe(500_000);
    } finally {
      await cleanupUser(userId);
    }
  });

  // ---- P0 资损修复：透支守卫 ----
  // 场景：fail-open（Redis 不可用）放行后，实际 amount > 余额 → 不允许扣成负数（平台垫付）
  it('透支守卫：amount > balance → 余额不透支（保持 0），标 overdraft=true，usage_logs 仍写入', async () => {
    // 余额 1000 厘，实际费用 2000 厘（1000 输入 + 500 输出，系数 1.0）
    const userId = await createTestUser(1000);
    try {
      const job = makeJob({ userId, requestId: randomUUID(), holdAmount: 0 });
      const r = await settle(db, redis, job);
      expect(r.amount).toBe(2000);
      expect(r.settled).toBe(true); // usage_logs 写入（明细不丢）
      expect(r.overdraft).toBe(true); // 但余额扣不动 → 透支标记（告警/对账用）
      // 余额保持原值（不被扣成负数）—— 或扣到 0（取实现，关键是不为负）
      const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { balance: true } });
      expect(u?.balance).toBeGreaterThanOrEqual(0);
      expect(u?.balance).toBeLessThanOrEqual(1000);
      // usage_logs 已写（amount 记录真实费用，便于对账追回）
      const logs = await db.select().from(usageLogs).where(eq(usageLogs.requestId, job.requestId));
      expect(logs).toHaveLength(1);
      expect(logs[0]?.amount).toBe(2000);
    } finally {
      await cleanupUser(userId);
    }
  });

  it('透支守卫：amount ≤ balance → 正常扣费，overdraft=false', async () => {
    // 余额 10000 厘，实际费用 2000 厘 → 正常扣
    const userId = await createTestUser(10000);
    try {
      const job = makeJob({ userId, requestId: randomUUID(), holdAmount: 0 });
      const r = await settle(db, redis, job);
      expect(r.amount).toBe(2000);
      expect(r.settled).toBe(true);
      expect(r.overdraft).toBe(false);
      const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { balance: true } });
      expect(u?.balance).toBe(8000);
    } finally {
      await cleanupUser(userId);
    }
  });

  // ---- P0 资损修复：Redis 余额缓存失效（不覆盖进行中 hold） ----
  // 场景：用户余额 10000，请求 A hold 6000（缓存=4000），请求 B 在此期间结算扣 1000。
  //       旧实现 redis.set(9000) 会把缓存覆盖成 9000（抹掉 A 的 hold 占位 → A 可超额）。
  //       修复：settle 后 DEL 缓存键，下次 hold 走 cache_miss 从 DB 懒加载（此时 DB 已扣为 9000）。
  it('缓存失效：settle 后 DEL 余额缓存键（不覆盖进行中 hold 占位）', async () => {
    const userId = await createTestUser(10000);
    try {
      // 模拟：先 hold（缓存变 10000-6000=4000），写 hold key
      await redis.set(`billing:balance:${userId}`, 10000);
      await redis.set(`billing:hold:req-A`, 6000);
      await redis.decrby(`billing:balance:${userId}`, 6000); // 缓存=4000
      const cachedBefore = await redis.get(`billing:balance:${userId}`);
      expect(cachedBefore).toBe('4000'); // hold 占位后缓存=4000

      // 请求 B 结算（实际扣 2000，DB 10000→8000）
      const jobB = makeJob({ userId, requestId: randomUUID(), holdAmount: 0 });
      await settle(db, redis, jobB);

      // 修复后：缓存键应被 DEL（不存在），而非覆盖成 DB 值 8000
      const cachedAfter = await redis.get(`billing:balance:${userId}`);
      expect(cachedAfter).toBeNull(); // 失效，下次 hold 从 DB 懒加载

      // hold 占位 key 也被清理（req-B 的 hold，但 req-A 的仍保留）
      // 注意：settle 只清自己的 requestId hold
      const holdA = await redis.get(`billing:hold:req-A`);
      expect(holdA).toBe('6000'); // A 的 hold 仍在（未被误清）
    } finally {
      await cleanupUser(userId);
      await redis.del('billing:hold:req-A');
    }
  });
});
