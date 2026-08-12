import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { users, usageLogs, transactions, channels, providers } from '@ai-gateway/db/schema';
import { Decimal } from '@ai-gateway/money';
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
 * settle 集成测试（重构后：元 + decimal 全精度）。
 * 需要真实 Postgres + Redis；无 DB/Redis 时 beforeAll 抛错 → 所有 it 自动跳过。
 *
 * 验证维度（资损防线）：
 *   - 幂等：同一 requestId 重复结算只扣一次
 *   - 并发安全：同一用户多个并发请求，余额准确（不丢更新、不重复扣）
 *   - 精度：亚厘级消耗精确计费（账本永不 round）
 *
 * 价格换算（厘→元，÷1000）：
 *   旧 inputPrice 1_000_000 厘/M = 1000 元/M → 新 'inputPrice: "1000"'
 *   旧 outputPrice 2_000_000 厘/M = 2000 元/M → 新 'outputPrice: "2000"'
 *   usage 1000 输入 + 500 输出：
 *     amount = (1000×1000 + 500×2000)/1e6 × 1.0 = (1e6 + 1e6)/1e6 = 2 元 = "2"
 *     （与旧 2000 厘 = ¥2 同口径）
 */
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

/** 创建测试专用用户（余额单位元，string），返回 userId */
async function createTestUser(balance: string): Promise<number> {
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
  // 重构后无 billing:balance 缓存，但清可能的残留
  await redis.del(`billing:balance:${userId}`).catch(() => {});
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
    inputPrice: '1000',
    outputPrice: '2000',
    cacheInputPrice: '100',
    coefficient: '1.0',
    durationMs: 100,
    stream: false,
    streamAborted: false,
    holdAmount: '0',
    mappingId: 1,
    ...overrides,
  };
}

/** 余额比较：DB 返回 string，用 Decimal.equals 比较（数值相等，不依赖字符串表示形式/科学计数法） */
function expectBal(actual: string | undefined, expected: string): void {
  expect(new Decimal(actual ?? '0').equals(new Decimal(expected))).toBe(true);
}

describe('settle 结算（元 + decimal 全精度，幂等 + 并发安全）', () => {
  it('幂等：同一 requestId 重复结算只扣一次', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser('1000');
    try {
      const job = makeJob({ userId, requestId: randomUUID() });
      // amount = (1000×1000 + 500×2000)/1e6 = 2 元
      const r1 = await settle(db, redis, job);
      expect(r1.settled).toBe(true);
      expect(new Decimal(r1.amount).toString()).toBe('2');

      // 重复结算同一 job（模拟 BullMQ 重试）
      const r2 = await settle(db, redis, job);
      expect(r2.settled).toBe(false); // 幂等跳过
      expect(new Decimal(r2.amount).toString()).toBe('2');

      // 余额只扣一次：1000 - 2 = 998
      const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { balance: true } });
      expectBal(u?.balance, '998');

      // transactions 只有一条
      const txs = await db.select().from(transactions).where(eq(transactions.refId, job.requestId));
      expect(txs).toHaveLength(1);
    } finally {
      await cleanupUser(userId);
    }
  });

  it('并发安全：同一用户 5 个并发请求，余额准确（不丢更新）', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser('1000');
    try {
      const jobs = Array.from({ length: 5 }, () =>
        makeJob({ userId, requestId: randomUUID() }),
      );
      // 并发结算（模拟多 worker 同时处理）
      const results = await Promise.all(jobs.map((j) => settle(db, redis, j)));
      // 全部成功结算
      expect(results.every((r) => r.settled)).toBe(true);
      // 每个扣 2 元，5 个共 10 元：1000 - 10 = 990
      const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { balance: true } });
      expectBal(u?.balance, '990');

      // 5 条流水，所有 amount 都是 -2
      const txs = await db.select().from(transactions).where(eq(transactions.userId, userId));
      expect(txs).toHaveLength(5);
      expect(txs.every((t) => new Decimal(t.amount).equals('-2'))).toBe(true);
    } finally {
      await cleanupUser(userId);
    }
  });

  it('并发幂等：同一 requestId 并发结算两次，只扣一次', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser('1000');
    try {
      const job = makeJob({ userId, requestId: randomUUID() });
      // 同一 requestId 并发结算两次（极端竞态）
      const [r1, r2] = await Promise.all([settle(db, redis, job), settle(db, redis, job)]);
      // 恰好一个 settled，一个跳过
      const settledCount = [r1, r2].filter((r) => r.settled).length;
      expect(settledCount).toBe(1);
      // 余额只扣一次：1000 - 2 = 998
      const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { balance: true } });
      expectBal(u?.balance, '998');
    } finally {
      await cleanupUser(userId);
    }
  });

  it('hold 标记存在时 settle 退预扣 + 扣实际（防双扣）；无标记时纯扣实际', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser('1000');
    try {
      // 无 hold 标记：settle 纯扣实际 amount（2 元）：1000 - 2 = 998
      const jobNoHold = makeJob({ userId, requestId: randomUUID() });
      const r1 = await settle(db, redis, jobNoHold);
      expect(r1.settled).toBe(true);
      let u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { balance: true } });
      expectBal(u?.balance, '998'); // 1000 - 2（无 hold 退款）

      // 有 hold 标记：settle 先退 hold（5）再扣实际（2）：998 + 5 - 2 = 1001
      const reqId2 = randomUUID();
      await redis.set(`billing:hold:${reqId2}`, `${userId}:5`);
      const jobWithHold = makeJob({ userId, requestId: reqId2 });
      const r2 = await settle(db, redis, jobWithHold);
      expect(r2.settled).toBe(true);
      u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { balance: true } });
      expectBal(u?.balance, '1001'); // 998 + 5(退 hold) - 2(实际)
    } finally {
      await cleanupUser(userId);
    }
  });

  it('零用量 → amount=0，不扣费但写 usage_logs', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser('500');
    try {
      const job = makeJob({
        userId,
        requestId: randomUUID(),
        usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, estimated: false },
      });
      const r = await settle(db, redis, job);
      expect(new Decimal(r.amount).toString()).toBe('0');
      expect(r.settled).toBe(true);
      const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { balance: true } });
      expectBal(u?.balance, '500');
    } finally {
      await cleanupUser(userId);
    }
  });

  // ---- 透支：允许负余额模型 ----
  // 业务模型：上游已实际执行（平台已付钱），成本真实发生 → 如实扣全额，余额可为负（=欠款）。
  // 下次充值自动抵扣；下次请求 hold 阶段因余额为负自然拒绝。
  it('透支：amount > balance → 如实扣全额，余额变负数（欠款），标 overdraft=true', async () => {
    if (!connected) return it.skip('no DB');
    // 余额 1 元，实际费用 2 元
    const userId = await createTestUser('1');
    try {
      const job = makeJob({ userId, requestId: randomUUID() });
      const r = await settle(db, redis, job);
      expect(new Decimal(r.amount).toString()).toBe('2');
      expect(r.settled).toBe(true); // usage_logs 写入（明细不丢）
      expect(r.overdraft).toBe(true); // 余额为负 → 透支标记（告警/对账用）
      // 余额如实扣成负数：1 - 2 = -1（欠款，下次充值抵扣）
      const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { balance: true } });
      expectBal(u?.balance, '-1');
      // usage_logs 已写（status=0 成功已计费，amount/payg 记录真实费用）
      const logs = await db.select().from(usageLogs).where(eq(usageLogs.requestId, job.requestId));
      expect(logs).toHaveLength(1);
      expect(new Decimal(logs[0]?.amount ?? '0').toString()).toBe('2');
      expect(new Decimal(logs[0]?.paygAmount ?? '0').toString()).toBe('2');
      expect(logs[0]?.status).toBe(0);
    } finally {
      await cleanupUser(userId);
    }
  });

  it('透支守卫：amount ≤ balance → 正常扣费，overdraft=false', async () => {
    if (!connected) return it.skip('no DB');
    // 余额 10 元，实际费用 2 元 → 正常扣
    const userId = await createTestUser('10');
    try {
      const job = makeJob({ userId, requestId: randomUUID() });
      const r = await settle(db, redis, job);
      expect(new Decimal(r.amount).toString()).toBe('2');
      expect(r.settled).toBe(true);
      expect(r.overdraft).toBe(false);
      const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { balance: true } });
      expectBal(u?.balance, '8');
    } finally {
      await cleanupUser(userId);
    }
  });

  it('【精度核心】亚厘级消耗精确计费（8 input + 1 output）', async () => {
    if (!connected) return it.skip('no DB');
    // 这正是重构要修复的资损 bug：旧厘+round 算出 0，现在精确计费
    // 价格用 DeepSeek 实际：输入 ¥0.001/M（=旧 1 厘/M×1000），输出 ¥0.002/M
    const userId = await createTestUser('0.001');
    try {
      const job = makeJob({
        userId,
        requestId: randomUUID(),
        usage: { inputTokens: 8, cachedInputTokens: 0, outputTokens: 1, estimated: false },
        inputPrice: '0.001',
        outputPrice: '0.002',
        cacheInputPrice: '0.0001',
      });
      const r = await settle(db, redis, job);
      // amount = (8×0.001 + 1×0.002)/1e6 = 0.01/1e6 = 1e-8 元（精确，非 0）
      expect(new Decimal(r.amount).equals(new Decimal('0.00000001'))).toBe(true);
      expect(r.settled).toBe(true);
      // 余额精确扣减：0.001 - 0.00000001 = 0.00099999
      const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { balance: true } });
      expectBal(u?.balance, '0.00099999');
    } finally {
      await cleanupUser(userId);
    }
  });

  it('settle 后清理自己的 hold 标记（billing:hold:{requestId}）', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser('100');
    try {
      const reqId = randomUUID();
      // 预置 hold 标记（模拟 gateway hold 后入队）
      await redis.set(`billing:hold:${reqId}`, `${userId}:2`);
      const job = makeJob({ userId, requestId: reqId });
      await settle(db, redis, job);
      // settle 后自己的 hold 标记应被清理
      const holdAfter = await redis.get(`billing:hold:${reqId}`);
      expect(holdAfter).toBeNull();
    } finally {
      await cleanupUser(userId);
      await redis.del(`billing:hold:`).catch(() => {});
    }
  });

  // ---- TPM 回填维度（G-RL 限流重构：user 维度按模型拆 + 新增 channel 维度）----
  it('TPM 回填：user:model 复合维度（拆分核心）+ model 维度；旧 user:${id} 不再回填', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser('1000');
    const mappingId = 88888; // 测试用虚拟 mappingId（usage_logs 无 FK 到 model_mappings）
    try {
      const job = makeJob({ userId, requestId: randomUUID(), channelId: null, mappingId });
      const r = await settle(db, redis, job);
      expect(r.settled).toBe(true);
      const minute = Math.floor(Date.now() / 60_000);
      // user:model 复合维度回填（totalTokens = input 1000 + output 500 = 1500）
      expect(parseInt((await redis.get(`tpm:user:${userId}:model:${mappingId}:${minute}`)) ?? '0', 10)).toBe(1500);
      // model 维度回填
      expect(parseInt((await redis.get(`tpm:model:${mappingId}:${minute}`)) ?? '0', 10)).toBe(1500);
      // 旧格式 user:${userId}（无 model 后缀）不再回填——拆分后该桶废弃
      expect(await redis.get(`tpm:user:${userId}:${minute}`)).toBeNull();
      await redis.del(`tpm:user:${userId}:model:${mappingId}:${minute}`, `tpm:model:${mappingId}:${minute}`);
    } finally {
      await cleanupUser(userId);
    }
  });

  it('TPM 回填：channel 维度（channelId 非空时回填，保护上游 API key 配额）', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser('1000');
    const mappingId = 88889;
    const suffix = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    // usage_logs.channel_id 有 FK → 创建真实 provider + channel
    const [prov] = await db.insert(providers).values({ name: 'tpm-prov-' + suffix, protocol: 'openai_compatible', baseUrl: 'http://localhost:9999', status: 0 }).returning();
    const [ch] = await db.insert(channels).values({ name: 'tpm-ch-' + suffix, providerId: prov!.id, apiKeyEnc: 'dummy', status: 0 }).returning();
    const channelId = ch!.id;
    try {
      const job = makeJob({ userId, requestId: randomUUID(), channelId, mappingId });
      const r = await settle(db, redis, job);
      expect(r.settled).toBe(true);
      const minute = Math.floor(Date.now() / 60_000);
      // channel 维度回填
      expect(parseInt((await redis.get(`tpm:channel:${channelId}:${minute}`)) ?? '0', 10)).toBe(1500);
      await redis.del(`tpm:user:${userId}:model:${mappingId}:${minute}`, `tpm:model:${mappingId}:${minute}`, `tpm:channel:${channelId}:${minute}`);
    } finally {
      // FK 顺序：usage_logs 引用 channel → 先删 usage_logs，再删 channel/provider
      await db.delete(usageLogs).where(eq(usageLogs.userId, userId)).catch(() => {});
      await db.delete(channels).where(eq(channels.id, channelId)).catch(() => {});
      await db.delete(providers).where(eq(providers.id, prov!.id)).catch(() => {});
      await cleanupUser(userId);
    }
  });
});
