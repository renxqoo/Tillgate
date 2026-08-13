import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Redis } from '@ai-gateway/http';
import { createDb, type Db } from '@ai-gateway/db';
import { users } from '@ai-gateway/db/schema';
import { hashPassword } from '@ai-gateway/identity';
import { loadRootEnvFile } from '@ai-gateway/http';
import { clientAuthRoutesPublic } from './auth.js';
import { makeClientPublicApp, makeServices, makeTestConfig } from '../test/helpers.js';

/**
 * TDD 回归测试 —— client-api 登录限流 IP 可通过 X-Forwarded-For 伪造绕过。
 *
 * 修复：@ai-gateway/identity 的 checkLoginThrottle/recordLoginFailure 采用双维度计数：
 *   - (identifier, ip) 防 单IP 爆破
 *   - identifier-only 防分布式爆破（username 不可被 XFF 伪造绕过）
 *
 * 本测试验证：
 *   - 固定 username + 每次换 XFF → 第 6 次仍触发 429（identifier-only 维度生效）
 *   - 对照组：固定 IP + 连续失败 → 触发 429
 *
 * 需要真实 Postgres + Redis。
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

function makeApp() {
  const services = makeServices(db, { redis });
  return makeClientPublicApp({ '/api/auth': clientAuthRoutesPublic(services, makeTestConfig()) });
}

async function createUser(subject: string, password: string): Promise<number> {
  const hash = await hashPassword(password);
  const [u] = await db.insert(users).values({
    issuer: 'local', subject, identityProvider: 'local', displayName: subject,
    balance: '0', passwordHash: hash,
  }).returning();
  return u!.id;
}

async function cleanup(uid: number, subject: string) {
  // namespace='user'，清理该 subject 的所有限流键
  for (const prefix of ['login:fails:user:', 'login:lock:user:']) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}${subject}*`, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  }
  await db.delete(users).where(eq(users.id, uid));
}

describe('client-api 登录限流：X-Forwarded-For 伪造不能绕过锁定', () => {
  it('固定 username + 每次换 XFF → 仍触发 429 锁定（identifier-only 维度兜底）', async () => {
    if (!connected) return it.skip('no DB');
    const subject = 'xff-bypass-' + Date.now();
    const uid = await createUser(subject, 'RightPass1');
    const app = makeApp();
    try {
      const body = JSON.stringify({ username: subject, password: 'WrongPass1' });
      let locked = false;
      let all401 = true;
      // 失败 50 次（远超阈值 5），但每次换 XFF
      for (let i = 0; i < 50; i++) {
        const fakeIp = `10.99.${i >> 8}.${i & 0xff}`;
        const res = await app.request('/api/auth/login', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': fakeIp,
          },
          body,
        });
        if (res.status === 429) { locked = true; break; }
        if (res.status !== 401) all401 = false;
      }
      // 修复后预期：identifier-only 维度使 fixed username 第 6 次开始触发 429
      expect(locked).toBe(true);
      expect(all401).toBe(true);
    } finally {
      await cleanup(uid, subject);
    }
  });

  it('对照组：固定 IP + 连续失败 → 应触发 429 锁定', async () => {
    if (!connected) return it.skip('no DB');
    const subject = 'xff-control-' + Date.now();
    const uid = await createUser(subject, 'RightPass1');
    const app = makeApp();
    try {
      const body = JSON.stringify({ username: subject, password: 'WrongPass1' });
      let locked = false;
      for (let i = 0; i < 8; i++) {
        const res = await app.request('/api/auth/login', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': '203.0.113.7', // 固定 IP
          },
          body,
        });
        if (res.status === 429) { locked = true; break; }
      }
      expect(locked).toBe(true);
    } finally {
      await cleanup(uid, subject);
    }
  });
});
