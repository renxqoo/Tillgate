import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createEphemeralRedis, type EphemeralRedis } from '@ai-gateway/http';
import { createDb, type Db } from '@ai-gateway/db';
import { users } from '@ai-gateway/db/schema';
import { hashPassword } from '@ai-gateway/identity';
import { loadRootEnvFile } from '@ai-gateway/http';
import { clientAuthRoutesPublic } from '../auth.js';
import { makeClientPublicApp, makeServices, makeTestConfig } from '../../test/helpers.js';

/**
 * TDD 回归测试 —— 登录限流的 IP 维度（02 修复后语义）。
 *
 * 修复前：identifier-only 维度会硬锁账号 → 任意匿名者换 IP 也能把目标账号锁死（登录 DoS）。
 * 修复后：硬锁只绑 (identifier, ip)，identifier-only 仅计数（分布式爆破观测信号，不锁定）。
 *   因此「固定 username + 每次换 XFF」不再触发 429 锁死账号，正确密码始终可用。
 *
 * 需要真实 Postgres + Redis。
 */

loadRootEnvFile();

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway';
const db: Db = createDb(DATABASE_URL);
let redis: EphemeralRedis;

let connected = false;
beforeAll(async () => {
  try {
    redis = await createEphemeralRedis();
    await db.query.users.findFirst({ where: eq(users.id, 1), columns: { id: true } });
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => {
  await redis?.close();
  await db.$client.end().catch(() => {});
});

function stubMailer() {
  return { async sendLoginCode() {} } as unknown as import('@ai-gateway/identity').Mailer;
}

function makeApp() {
  const services = makeServices(db, { redis, mailer: stubMailer() });
  return makeClientPublicApp({ '/api/auth': clientAuthRoutesPublic(services, makeTestConfig()) });
}

async function createUser(subject: string, password: string): Promise<{ uid: number; email: string }> {
  const hash = await hashPassword(password);
  const [u] = await db.insert(users).values({
    issuer: 'local', subject, identityProvider: 'local', email: `${subject}@test.local`, displayName: subject,
    balance: '0', passwordHash: hash,
  }).returning();
  return { uid: u!.id, email: `${subject}@test.local` };
}

async function cleanup(uid: number, subject: string) {
  for (const pattern of [`login:*:${subject}*`, `login:*:id:${subject}`]) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  }
  await db.delete(users).where(eq(users.id, uid));
}

function login(app: ReturnType<typeof makeApp>, email: string, password: string, ip?: string) {
  return app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(ip ? { 'x-forwarded-for': ip } : {}) },
    body: JSON.stringify({ email, password }),
  });
}

describe('client-api 登录限流：分布式爆破不再锁死账号（02 修复）', () => {
  // 50 次真实登录（scrypt+DB）是 I/O 密集用例：全量并行跑时 >5s 默认超时，放宽到 20s
  vi.setConfig({ testTimeout: 20_000 });
  it('固定 username + 每次换 XFF → 不再触发硬锁（全部 401），正确密码始终可用', async () => {
    if (!connected) return it.skip('no DB');
    const subject = 'xff-bypass-' + Date.now();
    const { uid, email } = await createUser(subject, 'RightPass1');
    const app = makeApp();
    try {
      let saw429 = false;
      let all401 = true;
      // 失败 50 次，但每次换 XFF（模拟分布式爆破）：每个 (username, ip) 各只失败 1 次
      for (let i = 0; i < 50; i++) {
        const fakeIp = `10.99.${i >> 8}.${i & 0xff}`;
        const res = await login(app, email, 'WrongPass1', fakeIp);
        if (res.status === 429) saw429 = true;
        if (res.status !== 401) all401 = false;
      }
      // 修复后：identifier-only 不锁定，分布式换 IP 不会锁死账号 → 0 个 429
      expect(saw429).toBe(false);
      expect(all401).toBe(true);

      // 正确密码仍然可用（合法用户不被分布式爆破锁死）
      const ok = await login(app, email, 'RightPass1', '203.0.113.9');
      expect(ok.status).toBe(200);
    } finally {
      await cleanup(uid, email);
    }
  });

  it('对照组：固定 IP + 连续失败 → 单源硬锁触发 429', async () => {
    if (!connected) return it.skip('no DB');
    const subject = 'xff-control-' + Date.now();
    const { uid, email } = await createUser(subject, 'RightPass1');
    const app = makeApp();
    try {
      let locked = false;
      for (let i = 0; i < 6; i++) {
        const res = await login(app, email, 'WrongPass1', '203.0.113.7');
        if (res.status === 429) { locked = true; break; }
      }
      expect(locked).toBe(true);
    } finally {
      await cleanup(uid, email);
    }
  });
});
