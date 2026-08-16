import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Redis } from '@ai-gateway/http';
import { createDb, type Db } from '@ai-gateway/db';
import { users, auditLogs, transactions } from '@ai-gateway/db/schema';
import { hashPassword } from '@ai-gateway/identity';
import { loadRootEnvFile } from '@ai-gateway/http';
import { clientAuthRoutesPublic } from './auth.js';
import { makeClientPublicApp, makeServices, makeTestConfig } from '../test/helpers.js';

/**
 * TDD 回归测试 —— client-api /api/auth/login 登录限流/锁定（02 修复后语义）。
 *
 * 安全模型：
 *   - 单源硬锁只绑 (identifier, ip)：同一来源连续失败达阈值（5）→ 后续「错误密码」429。
 *   - 正确密码豁免：锁定期间正确密码仍 200 并清零计数（攻击者无法锁死合法账号）。
 *   - 统一错误文案：用户不存在与密码错都返回 401 INVALID_CREDENTIALS。
 *
 * 需要真实 Postgres + Redis（hashPassword 走真实 scrypt）。
 */

loadRootEnvFile();

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

function stubMailer() {
  return {
    async sendLoginCode() {},
  } as unknown as import('@ai-gateway/identity').Mailer;
}

function makeApp() {
  const services = makeServices(db, { redis, mailer: stubMailer() });
  return makeClientPublicApp({ '/api/auth': clientAuthRoutesPublic(services, makeTestConfig()) });
}

async function createLocalUser(subject: string, password: string): Promise<{ uid: number; email: string }> {
  const hash = await hashPassword(password);
  const email = `${subject}@test.local`;
  const [u] = await db.insert(users).values({
    issuer: 'local', subject, identityProvider: 'local', email, displayName: subject,
    balance: '0', passwordHash: hash,
  }).returning();
  return { uid: u!.id, email };
}
async function cleanup(uid: number): Promise<void> {
  await db.delete(auditLogs).where(eq(auditLogs.adminId, uid));
  await db.delete(transactions).where(eq(transactions.userId, uid));
  await db.delete(users).where(eq(users.id, uid));
}

/** 清理某 subject 的所有登录限流键（含单源 + identifier-only 信号） */
async function clearThrottleKeys(subject: string): Promise<void> {
  for (const pattern of [`login:*:${subject}*`, `login:*:id:${subject}`]) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  }
}

function loginReq(app: ReturnType<typeof makeApp>, email: string, password: string) {
  return app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

describe('02 — client-api 登录限流（单源硬锁 + 正确密码豁免）', () => {
  it('单源连续失败达阈值（5）→ 第 5 次起错误密码 429；正确密码在锁定期间仍 200 并清零', async () => {
    if (!connected) return it.skip('no DB');
    const subject = 'brute-c6-' + Date.now();
    const { uid, email } = await createLocalUser(subject, 'RightPass1');
    const app = makeApp();
    try {
      // 前 4 次：密码错误 → 401（累计失败计数）
      for (let i = 0; i < 4; i++) {
        const res = await loginReq(app, email, 'WrongPass1');
        expect(res.status).toBe(401);
      }
      // 第 5 次：达阈值 → 单源锁定 → 429
      const res5 = await loginReq(app, email, 'WrongPass1');
      expect(res5.status).toBe(429);
      expect(res5.headers.get('retry-after')).not.toBeNull();

      // 正确密码豁免：锁定期间正确密码仍 200（进入验证码步），并清零计数（合法用户不被锁死）
      const resCorrect = await loginReq(app, email, 'RightPass1');
      expect(resCorrect.status).toBe(200);
      expect(((await resCorrect.json()) as { twoFactorRequired: boolean }).twoFactorRequired).toBe(true);

      // 清零后：再次失败 4 次仍 401（未误锁）
      for (let i = 0; i < 4; i++) {
        const r = await loginReq(app, email, 'WrongPass1');
        expect(r.status).toBe(401);
      }
    } finally {
      await clearThrottleKeys(email);
      await cleanup(uid);
    }
  });

  it('用户不存在与密码错误返回一致（401 INVALID_CREDENTIALS，不泄露账号存在性）', async () => {
    if (!connected) return it.skip('no DB');
    const subject = 'brute-c6-none-' + Date.now();
    const { uid, email } = await createLocalUser(subject, 'RightPass1');
    const app = makeApp();
    try {
      const wrong = await loginReq(app, email, 'WrongPass1');
      const nonexist = await loginReq(app, `ghost-${Date.now()}@test.local`, 'whatever');
      expect(wrong.status).toBe(401);
      expect(nonexist.status).toBe(401);
      expect(((await wrong.json()) as any).error?.code).toBe('INVALID_CREDENTIALS');
      expect(((await nonexist.json()) as any).error?.code).toBe('INVALID_CREDENTIALS');
    } finally {
      await clearThrottleKeys(email);
      await cleanup(uid);
    }
  });
});
