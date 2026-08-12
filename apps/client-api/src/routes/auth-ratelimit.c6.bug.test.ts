import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { Redis } from 'ioredis';
import { createDb, type Db } from '@ai-gateway/db';
import { users, auditLogs, transactions } from '@ai-gateway/db/schema';
import { clientAuthRoutes } from './auth.js';
import { userSessionMiddleware, hashPassword, type ClientEnv } from '@ai-gateway/identity';

/**
 * TDD 回归测试 —— client-api /api/auth/login 登录限流/锁定（C6）。
 *
 * gateway 对静态 Key 有 brute-force-guard（5 次失败锁 10 分钟），
 * 但用户登录路由原本没有任何限流/锁定。scrypt verifyPassword 可被放大 DoS。
 *
 * 拆分后登录逻辑迁到 client-api，限流函数从 @ai-gateway/identity 引入（namespace='user'）。
 * 本测试验证：连续失败达阈值（5 次）后锁定（429），成功登录清零计数。
 *
 * 需要真实 Postgres + Redis（hashPassword 走真实 scrypt）。
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
const SECRET = 'test-jwt-secret-0123456789-abcdef';

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

function makeApp(): Hono<ClientEnv> {
  const app = new Hono<ClientEnv>();
  app.use('/api/me/*', userSessionMiddleware(db, SECRET));
  app.use('/api/auth/password', userSessionMiddleware(db, SECRET));
  app.route('/', clientAuthRoutes(db, { jwtSecret: SECRET, giftAmount: 0, secureCookie: false, redis }));
  return app;
}

async function createLocalUser(subject: string, password: string): Promise<number> {
  const hash = await hashPassword(password);
  const [u] = await db.insert(users).values({
    issuer: 'local', subject, identityProvider: 'local', displayName: subject,
    balance: '0', passwordHash: hash,
  }).returning();
  return u!.id;
}
async function cleanup(uid: number): Promise<void> {
  // namespace='user'，清理对应键
  await db.delete(auditLogs).where(eq(auditLogs.adminId, uid));
  await db.delete(transactions).where(eq(transactions.userId, uid));
  await db.delete(users).where(eq(users.id, uid));
}

/** 清理某 subject 的所有限流键（namespace='user'） */
async function clearThrottleKeys(subject: string): Promise<void> {
  for (const prefix of ['login:fails:user:', 'login:lock:user:']) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}${subject}*`, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  }
}

describe('C6 — client-api 登录限流/锁定（修复后达阈值锁定）', () => {
  it('连续失败达阈值（5 次）后 → 后续尝试被锁定（429）', async () => {
    if (!connected) return it.skip('no DB');
    const subject = 'brute-c6-' + Date.now();
    const uid = await createLocalUser(subject, 'RightPass1');
    const app = makeApp();
    try {
      const body = JSON.stringify({ username: subject, password: 'WrongPass1' });
      const req = () => app.request('/api/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      });

      // 前 5 次：密码错误 → 401（并累计失败计数）
      for (let i = 0; i < 5; i++) {
        const res = await req();
        expect(res.status).toBe(401);
      }
      // 第 6 次：已达阈值（5 次失败）→ 锁定 → 429
      const res6 = await req();
      expect(res6.status).toBe(429);
      // retry-after 头存在
      expect(res6.headers.get('retry-after')).not.toBeNull();

      // 锁定期间：即便密码正确也被拒（429，不泄露密码对错）
      const correctBody = JSON.stringify({ username: subject, password: 'RightPass1' });
      const resCorrect = await app.request('/api/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: correctBody,
      });
      expect(resCorrect.status).toBe(429);
    } finally {
      await clearThrottleKeys(subject);
      await cleanup(uid);
    }
  });

  it('登录成功 → 清零计数（不误锁）', async () => {
    if (!connected) return it.skip('no DB');
    const subject = 'brute-c6-ok-' + Date.now();
    const uid = await createLocalUser(subject, 'RightPass1');
    const app = makeApp();
    try {
      // 4 次失败（未达阈值 5）
      for (let i = 0; i < 4; i++) {
        await app.request('/api/auth/login', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: subject, password: 'WrongPass1' }),
        });
      }
      // 正确密码 → 200（清零计数）
      const res = await app.request('/api/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: subject, password: 'RightPass1' }),
      });
      expect(res.status).toBe(200);
      // 再次失败 4 次仍不应锁（计数已清零，第 5 次才锁）
      for (let i = 0; i < 4; i++) {
        const r = await app.request('/api/auth/login', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: subject, password: 'WrongPass1' }),
        });
        expect(r.status).toBe(401); // 未达阈值，仍 401
      }
    } finally {
      await clearThrottleKeys(subject);
      await cleanup(uid);
    }
  });
});
