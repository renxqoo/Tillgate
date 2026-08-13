/**
 * 端到端真实接口验证（Bug 2 + Bug 4 修复）。
 *
 * 不依赖常驻服务：直接 import 生产 createApp（admin-api / gateway），在随机端口起 HTTP
 * server，用真实 Postgres + Redis，发真实 HTTP 请求复现并验证修复。
 *
 * 运行：pnpm tsx scripts/e2e-bugfix-verify.mts
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';

const cwd = dirname(fileURLToPath(import.meta.url));
// 加载根 .env
for (let dir = cwd, i = 0; i < 6; i++) {
  const f = resolve(dir, '.env');
  if (existsSync(f)) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (m && m[1] && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
    break;
  }
  const parent = resolve(dir, '..');
  if (parent === dir) break;
  dir = parent;
}
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'e2e-jwt-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ?? 'e2e-enc-9a4f2c7d8b1e5a3f6c0d4b2e8a7f1c9d';
process.env.NODE_ENV = process.env.NODE_ENV ?? 'development';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

// 动态 import（让生产代码读 process.env）
const { createDb } = await import('@ai-gateway/db');
const dbSchema = await import('@ai-gateway/db/schema');
const { Redis } = await import('ioredis');
const { serve } = await import('@hono/node-server');

const db = createDb(DATABASE_URL);
const redis = new Redis(REDIS_URL, {
  retryStrategy: () => null,
  lazyConnect: true,
  maxRetriesPerRequest: null,
});
await redis.connect();

const stamp = Date.now();
const created: Array<() => Promise<void>> = [];
const cleanup = async (): Promise<void> => {
  for (const fn of created.toReversed()) await fn().catch(() => {});
};

function startHono(
  fetch: (req: Request) => Promise<Response>,
): Promise<{ port: number; close: () => Promise<void> }> {
  // 用 @hono/node-server 的 serve（与生产入口同款），绑定随机端口隔离测试
  return new Promise((resolveFn, rejectFn) => {
    let server: ReturnType<typeof serve> extends infer S ? S : never;
    try {
      server = serve({ fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
        resolveFn({ port: info.port, close: () => new Promise((r) => server.close(() => r())) });
      });
    } catch (err) {
      rejectFn(err);
    }
  });
}

let step = 0;
const section = (t: string): void => console.log(`\n━━━ [${++step}] ${t} ━━━`);
const ok = (m: string): void => console.log(`  ✅ ${m}`);
const fail = (m: string): never => {
  console.error(`  ❌ ${m}`);
  process.exitCode = 1;
  throw new Error(m);
};

async function hashPassword(pw: string): Promise<string> {
  const { scryptSync, randomBytes } = await import('node:crypto');
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(pw, salt, 64).toString('hex');
  return `scrypt:32768:8:1:${salt}:${hash}`;
}

// ============================================================
// Bug 2 端到端：admin-api 真实 PATCH /api/admin/users/:id 不泄露 passwordHash
// ============================================================
async function verifyBug2(): Promise<void> {
  section('Bug 2 端到端：PATCH /api/admin/users/:id 不泄露 passwordHash');
  // 不 import admin-api/src/index.ts（顶层有 serve 副作用，会抢占端口）；
  // 直接组合真实生产路由 + 真实 adminAuthMiddleware，走真实 HTTP。
  const { Hono } = await import('hono');
  const { userAdminRoutes } = await import('../../admin-api/src/routes/users.ts');
  const { adminAuthMiddleware } = await import('../../admin-api/src/middleware/admin-auth.ts');
  const { signSession } = await import('../../admin-api/src/lib/session.ts');

  const adminSubject = `e2e-admin-${stamp}`;
  const targetSubject = `e2e-target-${stamp}`;
  const adminHash = await hashPassword('AdminPass1');
  const targetHash = await hashPassword('TargetPass1');
  const [admin] = await db
    .insert(dbSchema.users)
    .values({
      issuer: 'local',
      subject: adminSubject,
      identityProvider: 'local',
      displayName: adminSubject,
      status: 0,
      passwordHash: adminHash,
    })
    .returning();
  const [target] = await db
    .insert(dbSchema.users)
    .values({
      issuer: 'local',
      subject: targetSubject,
      identityProvider: 'local',
      displayName: targetSubject,
      status: 0,
      passwordHash: targetHash,
      balance: 0,
    })
    .returning();
  created.push(async () => {
    await db.delete(dbSchema.users).where(eq(dbSchema.users.id, admin!.id));
    await db.delete(dbSchema.users).where(eq(dbSchema.users.id, target!.id));
  });

  const app = new Hono();
  app.use('/api/admin/*', adminAuthMiddleware(db, process.env.JWT_SECRET!));
  app.route('/', userAdminRoutes(db));
  const { port, close } = await startHono(app.fetch);
  try {
    const cookie = await signSession({ userId: admin!.id, role: 1 }, process.env.JWT_SECRET!);
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/users/${target!.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: `ag_session=${cookie}` },
      body: JSON.stringify({ displayName: 'changed-e2e' }),
    });
    if (res.status !== 200) fail(`PATCH 应返回 200，实际 ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    if (body.passwordHash !== undefined) fail(`响应泄露 passwordHash: ${body.passwordHash}`);
    if (body.password_hash !== undefined) fail(`响应泄露 password_hash`);
    const serialized = JSON.stringify(body);
    if (/scrypt:32768:8:1:/.test(serialized)) fail(`响应含 scrypt 哈希串`);
    ok(`PATCH 响应不含 passwordHash（status=200，displayName=${body.displayName}）`);
  } finally {
    await close();
  }
}

// ============================================================
// Bug 4 端到端：gateway 真实 /v1/embeddings 遇 dead_credential 换渠道
// ============================================================
async function verifyBug4(): Promise<void> {
  section('Bug 4 端到端：embeddings 第一个渠道 dead_credential → 换渠道成功');
  const { createApp } = await import('../src/app.ts');
  const { encrypt, loadGatewayEnv, createLogger } = await import('@ai-gateway/core');
  const { RateLimiter } = await import('../src/services/billing/rate-limit-service.ts');
  const { BillingDispatcher } = await import('../src/services/billing/billing-dispatcher.ts');

  const externalModel = `e2e-emb-dead-${stamp}`;
  const realModel = externalModel + '-real';
  const userId = (
    await db
      .insert(dbSchema.users)
      .values({
        issuer: 'test',
        subject: `e2e-emb-user-${stamp}`,
        identityProvider: 'local',
        displayName: 'E2EEmb',
        balance: 1_000_000,
      })
      .returning()
  )[0]!.id;
  const token = 'ag_' + randomUUID().replace(/-/g, '');
  const keyHash = createHash('sha256').update(token).digest('hex');
  await db
    .insert(dbSchema.apiKeys)
    .values({ keyHash, keyPreview: 'ag_****', userId, name: 'e2e-emb', status: 0 });
  const [prov] = await db
    .insert(dbSchema.providers)
    .values({
      name: `e2e-prov-${stamp}`,
      protocol: 'openai_compatible',
      baseUrl: 'http://localhost:9999',
      status: 0,
    })
    .returning();
  const [ch1] = await db
    .insert(dbSchema.channels)
    .values({
      name: `e2e-ch1-${stamp}`,
      providerId: prov!.id,
      apiKeyEnc: encrypt('sk-dead', process.env.ENCRYPTION_KEY!),
      status: 0,
    })
    .returning();
  const [ch2] = await db
    .insert(dbSchema.channels)
    .values({
      name: `e2e-ch2-${stamp}`,
      providerId: prov!.id,
      apiKeyEnc: encrypt('sk-good', process.env.ENCRYPTION_KEY!),
      status: 0,
    })
    .returning();
  const [m] = await db
    .insert(dbSchema.modelMappings)
    .values({
      externalName: externalModel,
      realModel,
      status: 0,
      inputPrice: 1_000_000,
      outputPrice: 0,
      cacheInputPrice: 100_000,
    })
    .returning();
  await db.insert(dbSchema.modelChannels).values([
    { mappingId: m!.id, channelId: ch1!.id, priority: 0, weight: 1 },
    { mappingId: m!.id, channelId: ch2!.id, priority: 0, weight: 1 },
  ]);
  created.push(async () => {
    await db.delete(dbSchema.modelChannels).where(eq(dbSchema.modelChannels.mappingId, m!.id));
    await db.delete(dbSchema.modelMappings).where(eq(dbSchema.modelMappings.id, m!.id));
    await db.delete(dbSchema.channels).where(eq(dbSchema.channels.id, ch1!.id));
    await db.delete(dbSchema.channels).where(eq(dbSchema.channels.id, ch2!.id));
    await db.delete(dbSchema.providers).where(eq(dbSchema.providers.id, prov!.id));
    await db.delete(dbSchema.apiKeys).where(eq(dbSchema.apiKeys.keyHash, keyHash));
    await db.delete(dbSchema.users).where(eq(dbSchema.users.id, userId));
    await redis.del(`billing:balance:${userId}`, `auth:key:${keyHash}`);
  });

  // mock ai：第 1 次返回 dead_credential，第 2 次成功（不连真实上游，聚焦换渠道逻辑）
  let calls = 0;
  const ai = {
    chat: async () => {
      calls += 1;
      if (calls === 1)
        return {
          status: 'error',
          error: {
            code: 'dead_credential',
            message: 'invalid',
            retryable: false,
            circuitTrip: false,
          },
          durationMs: 5,
        };
      return {
        status: 'success',
        usage: { inputTokens: 5, cachedInputTokens: 0, outputTokens: 0, estimated: false },
        body: {
          object: 'list',
          data: [{ embedding: [0.1], index: 0 }],
          model: realModel,
          usage: { prompt_tokens: 5, total_tokens: 5 },
        },
        durationMs: 10,
      };
    },
    chatStream: async () => {
      throw new Error('not used');
    },
    probe: async () => true,
    onEvent: () => () => {},
  };

  const rateLimiter = new RateLimiter(redis);
  const billingDispatcher = new BillingDispatcher(redis);
  const app = createApp({
    db,
    ai: ai as never,
    redis,
    env: loadGatewayEnv(),
    logger: createLogger({ level: 'error' }),
    billingDispatcher,
    rateLimiter,
  });
  const { port, close } = await startHono(app.fetch);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: externalModel, input: 'hello' }),
    });
    if (res.status !== 200)
      fail(`embeddings 遇 dead_credential 应换渠道返回 200，实际 ${res.status}`);
    if (calls < 2) fail(`应至少调用两个渠道，实际 ${calls}`);
    ok(`embeddings 换渠道成功（status=200，ai.chat 调用 ${calls} 次：坏渠道→好渠道）`);
  } finally {
    await close();
    await meter.close().catch(() => {});
  }
}

// ============================================================
try {
  console.log('🧪 端到端真实接口验证（Bug 2 + Bug 4 修复）');
  console.log(`   DB: ${DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`);
  await verifyBug2();
  await verifyBug4();
  console.log('\n🎉 全部端到端验证通过');
} catch (err) {
  console.error('\n💥 端到端验证失败:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await cleanup();
  await redis.quit().catch(() => {});
  await db.$client.end().catch(() => {});
}
