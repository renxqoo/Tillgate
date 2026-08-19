/**
 * gateway 集成测试共享工具（路由级测试用：真实 DB/Redis + mock Ai）。
 * 非测试文件，vitest 不会当作用例执行。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import Redis from 'ioredis';
import { eq, and, inArray, like, sql } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import {
  users,
  apiKeys,
  modelMappings,
  channels,
  modelChannels,
  providers,
  usageLogs,
  transactions,
  requestLogs,
  billingRequests,
  plans,
  userSubscriptions,
} from '@ai-gateway/db/schema';
import {
  loadGatewayEnv,
  createLogger,
  encrypt,
  type GatewayEnv,
  type Logger,
} from '@ai-gateway/core';
import type { Ai } from '@ai-gateway/ai';
import { createWallet, type Wallet } from '@ai-gateway/wallet';
import { createApp } from '../app.js';
import { createRateLimiter } from '../services/billing/rate-limit-service.js';
import { createBillingDispatcher, type BillingDispatcher } from '../services/billing/billing-dispatcher.js';
import { createRequestLifecycle } from '../services/runtime/request-lifecycle.js';
import { createCompletionRegistry } from '../services/runtime/completion-registry.js';

export { encrypt };

/** 从当前文件向上找 monorepo 根 .env 并加载（vitest 不自动加载 .env） */
export function loadEnvFileIntoProcess(): void {
  let dir = dirname(fileURLToPath(import.meta.url));
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

/** 测试环境密钥（覆盖 .env 里可能的弱密钥占位值） */
export function ensureTestSecrets(): void {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-7f3a9b2e5c1d4a8f6e0b';
  process.env.ENCRYPTION_KEY =
    process.env.ENCRYPTION_KEY ?? 'test-enc-9a4f2c7d8b1e5a3f6c0d4b2e8a7f1c9d';
  process.env.NODE_ENV = process.env.NODE_ENV ?? 'development';
}

/**
 * 连接串在调用期读取（而非模块加载期）：测试文件先 loadEnvFileIntoProcess()
 * 再创建连接，模块级常量会在 .env 加载前求值导致拿到无密码默认值。
 */
export function testDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway';
}

export function testRedisUrl(): string {
  return process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
}

export function createTestDb(): Db {
  return createDb(testDatabaseUrl());
}

/** 测试用业务 Redis（与生产同参：lazyConnect，maxRetriesPerRequest=null 兼容 BullMQ） */
export function createTestRedis(): Redis {
  return new Redis(testRedisUrl(), {
    retryStrategy: () => null,
    lazyConnect: true,
    maxRetriesPerRequest: null,
  });
}

/** 探测 DB/Redis 是否可用（不可用时测试整体跳过） */
export async function isBackendAvailable(db: Db, redis?: Redis): Promise<boolean> {
  try {
    await db.query.users.findFirst({ where: eq(users.id, 1), columns: { id: true } });
    if (redis) await redis.ping();
    return true;
  } catch {
    return false;
  }
}

export interface TestModelIds {
  externalModel: string;
  realModel: string;
  channelId: number;
  providerId: number;
  mappingId: number;
}

/**
 * 测试钱包实例（PAYG 入金/断言用；refTypes 覆盖 billing 域 + 测试入金）。
 * 每 db 一个（幂等键按用户唯一，跨文件安全）。
 */
const testWallets = new WeakMap<Db, Wallet>();
export function walletForTests(db: Db): Wallet {
  let instance = testWallets.get(db);
  if (!instance) {
    instance = createWallet(db, {
      accounts: [],
      refTypes: ['topup', 'billing'],
      currencies: ['CNY'],
    });
    testWallets.set(db, instance);
  }
  return instance;
}

/**
 * 创建测试用户。默认同时建一条大额度有效订阅（供 subscription Key 走套餐额度分支）；
 * 测无订阅路径传 { withSubscription: false }。普通 Key/无 Key 则走余额（payg）分支。
 */
export async function createTestUser(
  db: Db,
  balance: string,
  prefix = 'u',
  opts: { withSubscription?: boolean } = {},
): Promise<number> {
  const subject = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [u] = await db
    .insert(users)
    .values({
      issuer: 'test',
      subject,
      identityProvider: 'local',
      displayName: prefix,
    })
    .returning();
  // S7：PAYG 资金事实在 wallet——测试入金走 wallet.credit（幂等键按用户唯一）
  if (balance !== '0') {
    await walletForTests(db).credit({
      userId: u!.id,
      amount: balance,
      refType: 'topup',
      refId: `test-topup-${u!.id}`,
    });
  }
  if (opts.withSubscription !== false) {
    const [p] = await db
      .insert(plans)
      .values({
        name: `subplan-${subject}`.slice(0, 32),
        kind: 'subscription',
        price: '0',
        periodDays: 3650,
        // 大到不会被额度闸挡（测试关注计费/路由逻辑，不关注额度耗尽）
        quotaAmount: '1000000000',
        sortOrder: null,
        status: 0,
      })
      .returning({ id: plans.id });
    await db.insert(userSubscriptions).values({
      userId: u!.id,
      planId: p!.id,
      startAt: new Date(),
      endAt: new Date(Date.now() + 3650 * 86_400_000),
      quotaAmount: '1000000000',
      usedAmount: '0',
      reservedAmount: '0',
      quantity: 1,
      price: '0',
      status: 0,
    });
  }
  return u!.id;
}

/** 读某用户当前 active 订阅 id（无则 null）。 */
export async function activeSubscriptionId(db: Db, userId: number): Promise<number | null> {
  const sub = await db.query.userSubscriptions.findFirst({
    where: and(eq(userSubscriptions.userId, userId), eq(userSubscriptions.status, 0)),
    columns: { id: true },
  });
  return sub?.id ?? null;
}

export async function createTestApiKey(
  db: Db,
  userId: number,
  name = 'test',
  subscriptionId: number | null = null,
): Promise<{ token: string; keyHash: string }> {
  const token = 'ag_' + randomUUID().replace(/-/g, '');
  const keyHash = createHash('sha256').update(token).digest('hex');
  await db
    .insert(apiKeys)
    .values({ keyHash, keyPreview: `ag_****${token.slice(-4)}`, userId, name, subscriptionId, status: 0 });
  return { token, keyHash };
}

export async function setupTestModel(
  db: Db,
  encryptionKey: string,
  opts: {
    inputPrice?: string;
    outputPrice?: string;
    cacheInputPrice?: string;
    fallbackModels?: string[];
    billingPolicy?: Record<string, unknown>;
    /** 计费单位（默认 token；单位计费用 image/request/second/char） */
    pricingUnit?: string;
    /** 单位单价（元/单位；单位计费模型的计量价） */
    unitPrice?: string;
    /** 定价分组键（费率卡 scope='group' 系数行匹配） */
    pricingGroup?: string;
  } = {},
): Promise<TestModelIds> {
  const suffix = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const externalModel = 'tmodel-' + suffix;
  const realModel = externalModel + '-real';
  const [prov] = await db
    .insert(providers)
    .values({
      name: 'tprov-' + suffix,
      protocol: 'openai-compatible',
      baseUrl: 'http://localhost:9999',
      status: 0,
    })
    .returning();
  const [ch] = await db
    .insert(channels)
    .values({
      name: 'tch-' + suffix,
      providerId: prov!.id,
      apiKeyEnc: encrypt('sk-dummy', encryptionKey),
      status: 0,
      // 进货额度给足，让路由精确硬闸放行（测试只验证计费/路由逻辑，不验证预算耗尽）
      upstreamBudget: '1000000',
    })
    .returning();
  const [m] = await db
    .insert(modelMappings)
    .values({
      externalName: externalModel,
      realModel,
      status: 0,
      inputPrice: opts.inputPrice ?? '1000',
      outputPrice: opts.outputPrice ?? '2000',
      cacheInputPrice: opts.cacheInputPrice ?? '100',
      fallbackModels: opts.fallbackModels ?? null,
      billingPolicy: opts.billingPolicy ?? null,
      pricingUnit: opts.pricingUnit ?? 'token',
      unitPrice: opts.unitPrice ?? '0',
      pricingGroup: opts.pricingGroup ?? null,
    })
    .returning();
  await db
    .insert(modelChannels)
    .values({ mappingId: m!.id, channelId: ch!.id, priority: 0, weight: 1 });
  return { externalModel, realModel, channelId: ch!.id, providerId: prov!.id, mappingId: m!.id };
}

export async function cleanupTestData(
  db: Db,
  redis: Redis,
  userId: number | null,
  keyHash: string | null,
  ids: Partial<TestModelIds> | null,
): Promise<void> {
  if (userId !== null) {
    // 先收集该用户订阅引用的「测试专属套餐」（subplan- 前缀），删订阅后一并清理
    const subs = await db
      .select({ planId: userSubscriptions.planId })
      .from(userSubscriptions)
      .where(eq(userSubscriptions.userId, userId))
      .catch(() => [] as Array<{ planId: number }>);
    await db
      .delete(userSubscriptions)
      .where(eq(userSubscriptions.userId, userId))
      .catch(() => {});
    // 先收集该用户账单中「仍在途」的渠道敞口（删除账单后用于同步清零渠道投影，
    // R4 教训：只删账单不平 channels.upstream_reserved 会留下无主敞口）。
    // 必须按在途状态过滤（与账本侧 R4 口径同一状态集）：settled/released 的渠道
    // 预占在结算/释放时已释放过，再扣一次会把投影蛀空 → 人工 resolve 的释放
    // 守卫失败 → state_conflict 复核单卡死（2026-08-16 渠道 2 实发）。
    const channelExposure = await db
      .select({
        channelId: billingRequests.channelId,
        total: sql<string>`coalesce(sum(${billingRequests.channelReservedAmount}),0)::numeric`,
      })
      .from(billingRequests)
      .where(
        and(
          eq(billingRequests.userId, userId),
          inArray(billingRequests.status, [
            'authorized',
            'in_flight',
            'settlement_pending',
            'processing',
            'retry_wait',
            'dead',
          ]),
        ),
      )
      .groupBy(billingRequests.channelId)
      .catch(() => [] as Array<{ channelId: number | null; total: string }>);
    await db
      .delete(billingRequests)
      .where(eq(billingRequests.userId, userId))
      .catch(() => {});
    for (const exp of channelExposure) {
      if (exp.channelId == null) continue;
      await db
        .update(channels)
        .set({
          upstreamReserved: sql`greatest(${channels.upstreamReserved} - ${exp.total}::numeric, 0)`,
        })
        .where(eq(channels.id, exp.channelId))
        .catch(() => {});
    }
    // 测试清理会绕过账务状态机直接删除预留明细；在途投影已在 wallet（S7），
    // 测试用户行随用随删，无需再清 users 侧投影（旧列已退役）。
    await db
      .delete(requestLogs)
      .where(eq(requestLogs.userId, userId))
      .catch(() => {});
    await db
      .delete(usageLogs)
      .where(eq(usageLogs.userId, userId))
      .catch(() => {});
    await db
      .delete(transactions)
      .where(eq(transactions.userId, userId))
      .catch(() => {});
    for (const planId of new Set(subs.map((s) => s.planId))) {
      // 名称前缀双重保险：只删 createTestUser 生成的测试套餐，绝不碰业务套餐
      await db
        .delete(plans)
        .where(and(eq(plans.id, planId), like(plans.name, 'subplan-%')))
        .catch(() => {});
    }
  }
  if (ids?.mappingId) {
    await db
      .delete(modelChannels)
      .where(eq(modelChannels.mappingId, ids.mappingId))
      .catch(() => {});
    await db
      .delete(modelMappings)
      .where(eq(modelMappings.id, ids.mappingId))
      .catch(() => {});
  }
  if (ids?.channelId)
    await db
      .delete(channels)
      .where(eq(channels.id, ids.channelId))
      .catch(() => {
        /* 渠道删除失败不阻塞清理（残留由名称前缀识别） */
      });
  if (ids?.providerId)
    await db
      .delete(providers)
      .where(eq(providers.id, ids.providerId))
      .catch(() => {});
  if (keyHash)
    await db
      .delete(apiKeys)
      .where(eq(apiKeys.keyHash, keyHash))
      .catch(() => {});
  if (userId !== null)
    await db
      .delete(users)
      .where(eq(users.id, userId))
      .catch(() => {});
  // bump 而非 del：版本计数必须单调递增（del 会让下次 incr 归 1，撞上残留
  // v1 缓存条目——与生产失效语义一致）
  await redis.incr('route:cache:v').catch(() => {});
  if (keyHash) await redis.del(`auth:key:${keyHash}`).catch(() => {});
}

/** 组装完整 gateway 应用（真实 DB/Redis + 注入 mock Ai；可注入 billingDispatcher spy） */
export function buildTestApp(
  db: Db,
  redis: Redis,
  ai: Ai,
  env: GatewayEnv = loadGatewayEnv(),
  logger: Logger = createLogger({ level: 'silent' }),
  billingDispatcher: BillingDispatcher = createBillingDispatcher(redis),
) {
  return createApp({
    db,
    ai,
    redis,
    env,
    logger,
    billingDispatcher,
    rateLimiter: createRateLimiter(redis),
    lifecycle: createRequestLifecycle(env.GATEWAY_REQUEST_DEADLINE_MS),
    completions: createCompletionRegistry(),
  });
}

/** 默认 mock Ai（各测试按需覆写 chat/chatStream 行为） */
export function makeMockAi(overrides: Partial<Ai> = {}): Ai {
  return {
    chat: async () => ({ status: 'error' as const, error: undefined, durationMs: 0 }),
    chatStream: async () => {
      throw new Error('chatStream not mocked');
    },
    probe: async () => ({ ok: false, durationMs: 0 }),
    onEvent: () => () => {},
    ...overrides,
  };
}

/**
 * 估算/真实结算已提交后的 billing_requests 可见状态集合（测试断言用）：
 * settlement_pending（网关已落收据）→ processing（worker 认领中）→ settled。
 * 本地 worker（tsx watch）可能在断言前完成认领甚至结算，三态皆合法。
 */
export const BILLING_SETTLE_STATES = ['settlement_pending', 'processing', 'settled'] as const;

/** 轮询等待该用户最新账单进入给定状态集合（收尾为异步） */
export async function waitForBillingStatus(
  db: Db,
  userId: number,
  states: readonly string[],
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const row = await db.query.billingRequests.findFirst({
      where: eq(billingRequests.userId, userId),
      columns: { status: true },
    });
    if (row && states.includes(row.status)) return;
    if (Date.now() - start >= timeoutMs) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}
