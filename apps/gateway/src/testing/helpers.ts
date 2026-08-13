/**
 * gateway 集成测试共享工具（路由级测试用：真实 DB/Redis + mock Ai）。
 * 非测试文件，vitest 不会当作用例执行。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import Redis from 'ioredis';
import { eq } from 'drizzle-orm';
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
} from '@ai-gateway/db/schema';
import {
  loadGatewayEnv,
  createLogger,
  encrypt,
  type GatewayEnv,
  type Logger,
} from '@ai-gateway/core';
import type { Ai } from '@ai-gateway/ai';
import { createApp } from '../app.js';
import { RateLimiter } from '../services/billing/rate-limit-service.js';
import { BillingDispatcher } from '../services/billing/billing-dispatcher.js';
import { RequestLifecycle } from '../services/runtime/request-lifecycle.js';
import { CompletionRegistry } from '../services/runtime/completion-registry.js';

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

export async function createTestUser(db: Db, balance: string, prefix = 'u'): Promise<number> {
  const [u] = await db
    .insert(users)
    .values({
      issuer: 'test',
      subject: `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      identityProvider: 'local',
      displayName: prefix,
      balance,
    })
    .returning();
  return u!.id;
}

export async function createTestApiKey(
  db: Db,
  userId: number,
  name = 'test',
): Promise<{ token: string; keyHash: string }> {
  const token = 'ag_' + randomUUID().replace(/-/g, '');
  const keyHash = createHash('sha256').update(token).digest('hex');
  await db
    .insert(apiKeys)
    .values({ keyHash, keyPreview: `ag_****${token.slice(-4)}`, userId, name, status: 0 });
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
  } = {},
): Promise<TestModelIds> {
  const suffix = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const externalModel = 'tmodel-' + suffix;
  const realModel = externalModel + '-real';
  const [prov] = await db
    .insert(providers)
    .values({
      name: 'tprov-' + suffix,
      protocol: 'openai_compatible',
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
    await db
      .delete(billingRequests)
      .where(eq(billingRequests.userId, userId))
      .catch(() => {});
    // 测试清理会绕过账务状态机直接删除预留明细，必须同步清理投影。
    // 生产代码禁止这种写法，只能通过 billing signal/settlement 转移状态。
    await db
      .update(users)
      .set({ reservedBalance: '0' })
      .where(eq(users.id, userId))
      .catch(() => {});
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
      .catch(() => {});
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
  await redis.del('route:cache:v').catch(() => {});
  if (keyHash) await redis.del(`auth:key:${keyHash}`).catch(() => {});
}

/** 组装完整 gateway 应用（真实 DB/Redis + 注入 mock Ai；可注入 billingDispatcher spy） */
export function buildTestApp(
  db: Db,
  redis: Redis,
  ai: Ai,
  env: GatewayEnv = loadGatewayEnv(),
  logger: Logger = createLogger({ level: 'silent' }),
  billingDispatcher: BillingDispatcher = new BillingDispatcher(redis),
) {
  return createApp({
    db,
    ai,
    redis,
    env,
    logger,
    billingDispatcher,
    rateLimiter: new RateLimiter(redis),
    lifecycle: new RequestLifecycle(env.GATEWAY_REQUEST_DEADLINE_MS),
    completions: new CompletionRegistry(),
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
