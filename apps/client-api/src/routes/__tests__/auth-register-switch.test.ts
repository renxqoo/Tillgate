import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { createDb, type Db } from '@ai-gateway/db';
import { users, auditLogs } from '@ai-gateway/db/schema';
import { createEphemeralRedis, loadRootEnvFile, errorHandler, type EphemeralRedis } from '@ai-gateway/http';
import { type Mailer } from '@ai-gateway/identity';

import { clientAuthRoutesPublic } from '../auth.js';
import { makeServices, makeTestConfig } from '../../test/helpers.js';

/**
 * 注册开关（REGISTER_ENABLED，默认开）：
 *   - 关闭：POST /register → 403 REGISTER_DISABLED（先于 captcha/限流短路），拒绝落审计
 *   - 关闭：POST /register/verify → 403（防开关翻转窗口内已有挑战的在建号）
 *   - 关闭：能力端点 enabled=false 且 captchaSiteKey=null（前端据此渲染关闭态）
 *   - 开启（默认）：行为与既有测试一致——不动登录/OAuth（关注册≠关登录）
 * 数据纪律：regoff- 前缀，finally 清理（DB 审计行 + Redis 键）。
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
    async send() {
      // 通用邮件（告警）在登录流测试中不可达
    },
  }) as Mailer & { sent: Array<{ to: string; code: string }> };
}

function makeApp(registerEnabled: boolean): Hono {
  const services = makeServices(db, { redis, mailer: stubMailer() });
  const app = new Hono();
  app.onError(errorHandler());
  app.route('/api/auth', clientAuthRoutesPublic(services, makeTestConfig({ registerEnabled })));
  return app;
}

const email = () => `regoff-${Date.now()}@test.local`;

function registerReq(app: Hono, addr: string) {
  return app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: addr, password: 'GoodPass123' }),
  });
}

async function cleanup(): Promise<void> {
  await db.delete(auditLogs).where(sql`${auditLogs.detail}->>'email' LIKE 'regoff-%'`);
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'register:req:*', 'COUNT', 100);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
}

/** 审计为旁路异步写入：短轮询等待（上限 1s） */
async function waitForAudit(action: string): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    const rows = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, action), sql`${auditLogs.detail}->>'email' LIKE 'regoff-%'`))
      .limit(1);
    if (rows.length > 0) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe('注册开关 REGISTER_ENABLED（默认开启）', () => {
  it('关闭：POST /register 403 REGISTER_DISABLED（先于 captcha/限流），拒绝落审计', async (ctx) => {
    if (!connected) return ctx.skip();
    const app = makeApp(false);
    try {
      const addr = email();
      const res = await registerReq(app, addr);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('REGISTER_DISABLED');
      expect(await waitForAudit('auth.register.disabled')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('关闭：POST /register/verify 403（防开关翻转窗口内既有挑战继续建号）', async (ctx) => {
    if (!connected) return ctx.skip();
    const app = makeApp(false);
    const res = await app.request('/api/auth/register/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: '00000000-0000-4000-8000-000000000000', code: '123456' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('REGISTER_DISABLED');
  });

  it('能力端点：关闭 → enabled=false 且 captchaSiteKey=null；开启 → enabled=true', async (ctx) => {
    if (!connected) return ctx.skip();
    const off = await makeApp(false).request('/api/auth/register/capabilities');
    expect(off.status).toBe(200);
    expect((await off.json()) as object).toEqual({ enabled: false, captchaSiteKey: null });

    const on = await makeApp(true).request('/api/auth/register/capabilities');
    expect(on.status).toBe(200);
    expect(((await on.json()) as { enabled: boolean }).enabled).toBe(true);
  });

  it('关闭注册 ≠ 关闭登录：POST /login 不受影响', async (ctx) => {
    if (!connected) return ctx.skip();
    const app = makeApp(false);
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email(), password: 'Whatever123' }),
    });
    // 走到 invalid_credentials（401）即证明未被开关拦截
    expect(res.status).toBe(401);
  });
});
