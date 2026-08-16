import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { createDb, type Db } from '@ai-gateway/db';
import { users, auditLogs } from '@ai-gateway/db/schema';
import { createEphemeralRedis, loadRootEnvFile, errorHandler, type EphemeralRedis } from '@ai-gateway/http';
import { hashPassword, type Mailer } from '@ai-gateway/identity';

import { clientAuthRoutesPublic } from '../auth.js';
import { makeServices, makeTestConfig } from '../../test/helpers.js';

/**
 * 登录/注册流程错误翻译的特征测试（服务层抛错重构的护栏）：
 *   - 每个失败 kind → HTTP 语义（状态码 + 业务码 + retry-after + 关键文案）
 *   - 审计动作命名 auth.<flow>.<kind>（审计写入从路由挪入 service 后必须逐字保持）
 * 数据纪律：flw- 前缀，finally 双条件清理（动作名/邮箱前缀 + 自建行）。
 */

loadRootEnvFile();

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
let redis: EphemeralRedis;

let connected = false;
beforeAll(async () => {
  try {
    redis = await createEphemeralRedis();
    await db.select({ id: users.id }).from(users).limit(1);
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => {
  await redis?.close();
  await db.$client.end().catch(() => {});
});

function stubMailer(): Mailer & { sent: Array<{ to: string; code: string }> } {
  const m = { sent: [] as Array<{ to: string; code: string }> };
  return Object.assign(m, {
    async sendLoginCode(to: string, code: string) {
      m.sent.push({ to, code });
    },
  }) as Mailer & { sent: Array<{ to: string; code: string }> };
}

/** sendLoginCode 一律抛错（模拟 SMTP 宕机） */
function throwingMailer(): Mailer {
  return {
    async sendLoginCode() {
      throw new Error('smtp down');
    },
  } as unknown as Mailer;
}

function makeApp(mailer: Mailer | null) {
  const services = makeServices(db, { redis, mailer });
  const app = new Hono();
  app.onError(errorHandler());
  app.route('/api/auth', clientAuthRoutesPublic(services, makeTestConfig()));
  return app;
}

let seq = 0;
async function createUser(status = 0): Promise<{ uid: number; email: string }> {
  const email = `flw-${Date.now()}-${seq++}@test.local`;
  const hash = await hashPassword('RightPass1');
  const [u] = await db
    .insert(users)
    .values({
      issuer: 'local',
      subject: `flw-${Date.now()}-${seq}`,
      identityProvider: 'local',
      email,
      displayName: 'flw 测试用户',
      balance: '0',
      passwordHash: hash,
      status,
    })
    .returning({ id: users.id });
  return { uid: u!.id, email };
}

async function errCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

function loginReq(app: Hono, email: string, password: string) {
  return app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

function verifyReq(app: Hono, path: string, challengeId: string, code: string) {
  return app.request(`/api/auth/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId, code }),
  });
}

function registerReq(app: Hono, email: string, password: string) {
  return app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

/** 审计为旁路异步写入：轮询等待落库 */
async function waitForAudit(action: string, email: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const rows = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, action), sql`${auditLogs.detail}->>'email' = ${email}`));
    if (rows.length > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`audit row not found: ${action}`);
}

async function cleanup(uid: number, email: string): Promise<void> {
  await db
    .delete(auditLogs)
    .where(sql`${auditLogs.detail}->>'email' = ${email}`)
    .catch(() => {});
  await db.delete(users).where(and(eq(users.id, uid), eq(users.email, email)));
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `logincode:*:${uid}`, 'COUNT', 100);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
  cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `login:*:*${email}*`, 'COUNT', 100);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
}

describe('登录/注册流程错误翻译（特征测试）', () => {
  it('已注销账号 → 403 ACCOUNT_UNAVAILABLE（不区分封禁/注销）', async (ctx) => {
    if (!connected) return ctx.skip();
    const { uid, email } = await createUser(2);
    const app = makeApp(stubMailer());
    try {
      const res = await loginReq(app, email, 'RightPass1');
      expect(res.status).toBe(403);
      expect(await errCode(res)).toBe('ACCOUNT_UNAVAILABLE');
    } finally {
      await cleanup(uid, email);
    }
  });

  it('SMTP 投递失败 → 502 CODE_SEND_FAILED，且冷却被回滚（可立即重试）', async (ctx) => {
    if (!connected) return ctx.skip();
    const { uid, email } = await createUser();
    const app = makeApp(throwingMailer());
    try {
      const res = await loginReq(app, email, 'RightPass1');
      expect(res.status).toBe(502);
      expect(await errCode(res)).toBe('CODE_SEND_FAILED');

      // 挑战与冷却一并回滚 → 换正常 mailer 立即重试成功（不是 429）
      const retry = await loginReq(makeApp(stubMailer()), email, 'RightPass1');
      expect(retry.status).toBe(200);
    } finally {
      await cleanup(uid, email);
    }
  });

  it('login/verify 未知挑战 → 400 CHALLENGE_INVALID（文案提示重新登录）', async (ctx) => {
    if (!connected) return ctx.skip();
    const app = makeApp(stubMailer());
    const res = await verifyReq(app, 'login/verify', randomUUID(), '123456');
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('CHALLENGE_INVALID');
    expect(body.error.message).toContain('重新登录');
  });

  it('挑战签发后账号被封禁 → verify 403 ACCOUNT_UNAVAILABLE', async (ctx) => {
    if (!connected) return ctx.skip();
    const { uid, email } = await createUser();
    const mailer = stubMailer();
    const app = makeApp(mailer);
    try {
      const step1 = await loginReq(app, email, 'RightPass1');
      const b1 = (await step1.json()) as { challengeId: string };

      await db.update(users).set({ status: 1 }).where(eq(users.id, uid));
      const res = await verifyReq(app, 'login/verify', b1.challengeId, mailer.sent[0]!.code);
      expect(res.status).toBe(403);
      expect(await errCode(res)).toBe('ACCOUNT_UNAVAILABLE');
    } finally {
      await cleanup(uid, email);
    }
  });

  it('register/verify 未知挑战 → 400 CHALLENGE_INVALID（文案提示重新注册）', async (ctx) => {
    if (!connected) return ctx.skip();
    const app = makeApp(stubMailer());
    const res = await verifyReq(app, 'register/verify', randomUUID(), '123456');
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('CHALLENGE_INVALID');
    expect(body.error.message).toContain('重新注册');
  });

  it('注册 SMTP 投递失败 → 502 CODE_SEND_FAILED', async (ctx) => {
    if (!connected) return ctx.skip();
    const email = `flw-${Date.now()}-${seq++}@test.local`;
    const app = makeApp(throwingMailer());
    try {
      const res = await registerReq(app, email, 'Abcd1234!');
      expect(res.status).toBe(502);
      expect(await errCode(res)).toBe('CODE_SEND_FAILED');
      // 未建号（注册第一步不落库）
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.issuer, 'local'), eq(users.email, email)));
      expect(rows).toHaveLength(0);
      await db
        .delete(auditLogs)
        .where(sql`${auditLogs.detail}->>'email' = ${email}`)
        .catch(() => {});
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `logincode:*:${email}`, 'COUNT', 100);
        cursor = next;
        if (keys.length > 0) await redis.del(...keys);
      } while (cursor !== '0');
    } finally {
      await cleanup(-1, email);
    }
  });

  it('审计动作命名 auth.login.<kind>（失败与成功发码均落审计）', async (ctx) => {
    if (!connected) return ctx.skip();
    const { uid, email } = await createUser();
    const app = makeApp(stubMailer());
    try {
      const wrong = await loginReq(app, email, 'WrongPass');
      expect(wrong.status).toBe(401);
      const ok = await loginReq(app, email, 'RightPass1');
      expect(ok.status).toBe(200);

      await waitForAudit('auth.login.invalid_credentials', email);
      await waitForAudit('auth.login.code_required', email);
    } finally {
      await cleanup(uid, email);
    }
  });
});
