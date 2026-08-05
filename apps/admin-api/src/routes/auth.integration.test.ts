import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createDb, type Db } from '@ai-gateway/db';
import { users, transactions, auditLogs } from '@ai-gateway/db/schema';
import { Decimal } from '@ai-gateway/money';
import { authRoutes } from './auth.js';
import { userSessionMiddleware, type AdminEnv } from '../middleware/session.js';
import { hashPassword } from '../lib/password.js';
import { signSession } from '../lib/session.js';

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
const db: Db = createDb(DATABASE_URL);
const SECRET = 'test-jwt-secret-0123456789';
const GIFT = 1; // ¥1（元，重构后金额单位为元）

/** 余额比较：DB 返回 string（numeric 带尾随零），用 Decimal.equals */
function expectDec(actual: string | undefined, expected: string | number): void {
  expect(new Decimal(actual ?? '0').equals(new Decimal(String(expected)))).toBe(true);
}

let connected = false;
beforeAll(async () => {
  try {
    await db.query.users.findFirst({ where: eq(users.id, 1), columns: { id: true } });
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => {
  await db.$client.end().catch(() => {});
});

function makeApp(): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();
  app.use('/api/me/*', userSessionMiddleware(db, SECRET));
  app.use('/api/auth/password', userSessionMiddleware(db, SECRET));
  app.route('/', authRoutes(db, { jwtSecret: SECRET, giftAmount: GIFT, secureCookie: false }));
  return app;
}

async function createLocalUser(subject: string, password: string, balance: string, status = 0): Promise<number> {
  const hash = await hashPassword(password);
  const [u] = await db.insert(users).values({
    issuer: 'local',
    subject,
    identityProvider: 'local',
    displayName: subject,
    balance,
    status,
    passwordHash: hash,
  }).returning();
  return u!.id;
}
async function cleanup(uid: number): Promise<void> {
  // audit_logs.admin_id 引用 users.id（FK），先清审计再清用户
  await db.delete(auditLogs).where(eq(auditLogs.adminId, uid));
  await db.delete(transactions).where(eq(transactions.userId, uid));
  await db.delete(users).where(eq(users.id, uid));
}

describe('登录 + 新用户赠送（集成）', () => {
  it('正确密码 → 登录成功 + Set-Cookie', async () => {
    if (!connected) return it.skip('no DB');
    const subject = 'login-test-' + Date.now();
    const uid = await createLocalUser(subject, 'Passw0rd!', '5');
    const app = makeApp();
    try {
      const res = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: subject, password: 'Passw0rd!' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; user: { id: number; role: number; gifted: boolean } };
      expect(body.ok).toBe(true);
      expect(body.user.id).toBe(uid);
      expect(body.user.gifted).toBe(false); // 余额 5000 ≠ 0，不赠送
      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).toContain('ag_session=');
      expect(setCookie).toContain('HttpOnly');
    } finally {
      await cleanup(uid);
    }
  });

  it('错误密码 → 401（统一消息，防枚举）', async () => {
    if (!connected) return it.skip('no DB');
    const subject = 'login-test-' + Date.now();
    const uid = await createLocalUser(subject, 'RightPass1', '0');
    const app = makeApp();
    try {
      const res = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: subject, password: 'WrongPass1' }),
      });
      expect(res.status).toBe(401);
      const body = await res.json() as { error: { message: string } };
      expect(body.error.message).toBe('用户名或密码错误');
    } finally {
      await cleanup(uid);
    }
  });

  it('不存在的用户 → 同样 401 同样消息（防用户名枚举）', async () => {
    if (!connected) return it.skip('no DB');
    const app = makeApp();
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'nonexistent-' + Date.now(), password: 'whatever' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toBe('用户名或密码错误');
  });

  it('封禁用户 → 403', async () => {
    if (!connected) return it.skip('no DB');
    const subject = 'banned-' + Date.now();
    const uid = await createLocalUser(subject, 'Passw0rd!', '0', 1);
    const app = makeApp();
    try {
      const res = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: subject, password: 'Passw0rd!' }),
      });
      expect(res.status).toBe(403);
    } finally {
      await cleanup(uid);
    }
  });

  it('新用户（余额0 + 无流水）首次登录 → 自动赠送 ¥1', async () => {
    if (!connected) return it.skip('no DB');
    const subject = 'newuser-' + Date.now();
    const uid = await createLocalUser(subject, 'Passw0rd!', '0');
    const app = makeApp();
    try {
      const res = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: subject, password: 'Passw0rd!' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { user: { gifted: boolean } };
      expect(body.user.gifted).toBe(true);
      const u = await db.query.users.findFirst({ where: eq(users.id, uid) });
      expectDec(u?.balance, GIFT);
      const txs = await db.select().from(transactions).where(eq(transactions.userId, uid));
      expect(txs).toHaveLength(1);
      expect(txs[0]!.type).toBe('gift');
      expectDec(txs[0]!.amount, GIFT);
    } finally {
      await cleanup(uid);
    }
  });

  it('第二次登录不再赠送（按身份源唯一判定防刷）', async () => {
    if (!connected) return it.skip('no DB');
    const subject = 'repeat-' + Date.now();
    const uid = await createLocalUser(subject, 'Passw0rd!', '0');
    const app = makeApp();
    try {
      // 第一次：赠送
      await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: subject, password: 'Passw0rd!' }),
      });
      // 第二次：不应再赠送
      const res2 = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: subject, password: 'Passw0rd!' }),
      });
      const body2 = await res2.json() as { user: { gifted: boolean } };
      expect(body2.user.gifted).toBe(false);
      const u = await db.query.users.findFirst({ where: eq(users.id, uid) });
      expectDec(u?.balance, GIFT); // 仍是首次赠送的额度，未重复加
    } finally {
      await cleanup(uid);
    }
  });

  it('注销接口 → 清 Cookie', async () => {
    if (!connected) return it.skip('no DB');
    const app = makeApp();
    const res = await app.request('/api/auth/logout', { method: 'POST' });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/ag_session=;/); // 空值清空
  });

  it('修改密码：旧密码正确 → 成功；登录可用新密码', async () => {
    if (!connected) return it.skip('no DB');
    const subject = 'chpwd-' + Date.now();
    const uid = await createLocalUser(subject, 'OldPass1', '0.1');
    const app = makeApp();
    const session = await signSession({ userId: uid, role: 0 }, SECRET);
    try {
      const res = await app.request('/api/auth/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `ag_session=${session}` },
        body: JSON.stringify({ oldPassword: 'OldPass1', newPassword: 'NewPass123' }),
      });
      expect(res.status).toBe(200);
      // 新密码登录成功
      const loginRes = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: subject, password: 'NewPass123' }),
      });
      expect(loginRes.status).toBe(200);
    } finally {
      await cleanup(uid);
    }
  });
});
