import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { createDb, type Db } from '@ai-gateway/db';
import { users, auditLogs, transactions } from '@ai-gateway/db/schema';
import { createEphemeralRedis, loadRootEnvFile, errorHandler, type EphemeralRedis } from '@ai-gateway/http';
import { CaptchaError, type Mailer, type CaptchaService } from '@ai-gateway/identity';

import { clientAuthRoutesPublic } from '../auth.js';
import { makeServices, makeTestConfig } from '../../test/helpers.js';

/**
 * 注册面人机验证门禁（Turnstile，防分布式刷号薅赠额）：
 *   - 启用后：缺 token → 400 CAPTCHA_REQUIRED；验签不过 → 400 CAPTCHA_INVALID；
 *     厂商不可达 → 503 CAPTCHA_UNAVAILABLE（fail-closed，绝不静默放行）
 *   - x-internal-token 恒定时间匹配 → 豁免（可信服务间调用）；不匹配不豁免
 *   - 未启用（null）→ 保持旧行为，无 token 亦放行
 *   - GET /api/auth/captcha 能力端点：前端据此决定是否渲染 widget（单一真相在后端）
 *   - 门禁拒绝同样落审计（auth.register.captcha_*，机器人活动可观测）
 * 数据纪律：regcap- 前缀，finally 清理（DB 审计行 + Redis 键）。
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
    async send() {},
  }) as Mailer & { sent: Array<{ to: string; code: string }> };
}

/** 恒定结果的验证器桩（Turnstile 测试 siteKey 造型；失败按抛式契约抛 CaptchaError） */
function stubCaptcha(result: { ok: boolean; reason?: 'invalid' | 'unavailable' }): CaptchaService {
  return {
    siteKey: '1x00000000000000000000AA',
    async verify() {
      if (!result.ok) throw new CaptchaError(result.reason ?? 'invalid');
    },
  };
}

function makeApp(
  captcha: CaptchaService | null,
  configOverrides: Parameters<typeof makeTestConfig>[0] = {},
): { app: Hono; mailer: Mailer & { sent: Array<{ to: string; code: string }> } } {
  const mailer = stubMailer();
  const services = makeServices(db, { redis, mailer, captcha });
  const app = new Hono();
  app.onError(errorHandler());
  app.route('/api/auth', clientAuthRoutesPublic(services, makeTestConfig({ giftAmount: 1, ...configOverrides })));
  return { app, mailer };
}

let seq = 0;
const nextEmail = () => `regcap-${Date.now()}-${seq++}@test.local`;

interface RegisterOptions {
  captchaToken?: string;
  ip?: string;
  headers?: Record<string, string>;
}

function registerReq(app: Hono, email: string, opts: RegisterOptions = {}) {
  return app.request('/api/auth/register', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.ip ? { 'x-forwarded-for': opts.ip } : {}),
      ...opts.headers,
    },
    body: JSON.stringify({ email, password: 'GoodPass123', ...(opts.captchaToken ? { captchaToken: opts.captchaToken } : {}) }),
  });
}

async function errCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

async function cleanup(email: string): Promise<void> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.issuer, 'local'), eq(users.email, email)))
    .limit(1);
  if (rows[0]) {
    await db.delete(auditLogs).where(eq(auditLogs.adminId, rows[0].id));
    await db.delete(transactions).where(eq(transactions.userId, rows[0].id));
    await db.delete(users).where(eq(users.id, rows[0].id));
  }
  await db.delete(auditLogs).where(sql`${auditLogs.detail}->>'email' LIKE 'regcap-%'`);
  for (const pattern of [`logincode:*:*regcap-*`, `login:*:*regcap-*`]) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  }
}

/** 审计为旁路异步写入：短轮询等待（上限 1s） */
async function waitForAudit(action: string, email: string): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    const rows = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, action), sql`${auditLogs.detail}->>'email' = ${email}`))
      .limit(1);
    if (rows.length > 0) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe('注册面人机验证门禁', () => {
  it('GET /register/capabilities 能力端点：启用返回 siteKey，未启用返回 null', async (ctx) => {
    if (!connected) return ctx.skip();
    const on = makeApp(stubCaptcha({ ok: true }));
    const off = makeApp(null);

    const resOn = await on.app.request('/api/auth/register/capabilities');
    expect(resOn.status).toBe(200);
    expect((await resOn.json()) as object).toEqual({
      enabled: true,
      captchaSiteKey: '1x00000000000000000000AA',
    });

    const resOff = await off.app.request('/api/auth/register/capabilities');
    expect(resOff.status).toBe(200);
    expect((await resOff.json()) as object).toEqual({ enabled: true, captchaSiteKey: null });
  });

  it('缺 token 400 CAPTCHA_REQUIRED；无效 token 400 CAPTCHA_INVALID；厂商不可达 503 CAPTCHA_UNAVAILABLE；拒绝落审计', async (ctx) => {
    if (!connected) return ctx.skip();
    const email = nextEmail();
    const { app } = makeApp(stubCaptcha({ ok: false, reason: 'invalid' }));
    try {
      const missing = await registerReq(app, email, { ip: '203.0.113.101' });
      expect(missing.status).toBe(400);
      expect(await errCode(missing)).toBe('CAPTCHA_REQUIRED');
      expect(await waitForAudit('auth.register.captcha_required', email)).toBe(true);

      const invalid = await registerReq(app, email, { ip: '203.0.113.101', captchaToken: 'stale-or-forged' });
      expect(invalid.status).toBe(400);
      expect(await errCode(invalid)).toBe('CAPTCHA_INVALID');

      const down = makeApp(stubCaptcha({ ok: false, reason: 'unavailable' })).app;
      const unavailable = await registerReq(down, email, { ip: '203.0.113.102', captchaToken: 'tok' });
      expect(unavailable.status).toBe(503);
      expect(await errCode(unavailable)).toBe('CAPTCHA_UNAVAILABLE');
    } finally {
      await cleanup(email);
      for (const ip of ['203.0.113.101', '203.0.113.102']) await redis.del(`register:req:${ip}`);
    }
  });

  it('验签通过 → 放行正常注册流（发码 + challengeId，不建号）', async (ctx) => {
    if (!connected) return ctx.skip();
    const email = nextEmail();
    const { app, mailer } = makeApp(stubCaptcha({ ok: true }));
    try {
      const res = await registerReq(app, email, { ip: '203.0.113.103', captchaToken: 'valid-token' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { challengeId: string };
      expect(body.challengeId).toBeTypeOf('string');
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]!.to).toBe(email);
    } finally {
      await cleanup(email);
      await redis.del('register:req:203.0.113.103');
    }
  });

  it('x-internal-token 匹配豁免（可信服务间）；不匹配即便经受信 Origin 也不豁免', async (ctx) => {
    if (!connected) return ctx.skip();
    const email = nextEmail();
    const internalToken = 'test-internal-token-0123456789ab';
    const { app } = makeApp(stubCaptcha({ ok: false, reason: 'invalid' }), {
      internalApiToken: internalToken,
      trustedOrigins: ['http://localhost:3001'],
    });
    try {
      // 无 Origin + 正确内部令牌：过 CSRF 且豁免 captcha，直接走注册流
      const exempt = await registerReq(app, email, {
        ip: '203.0.113.104',
        headers: { 'x-internal-token': internalToken },
      });
      expect(exempt.status).toBe(200);

      // 受信 Origin + 错误内部令牌：CSRF 放行，但 captcha 门禁不认错令牌
      const forged = await registerReq(app, nextEmail(), {
        ip: '203.0.113.104',
        headers: { origin: 'http://localhost:3001', 'x-internal-token': 'wrong-token-0123456789abcd' },
      });
      expect(forged.status).toBe(400);
      expect(await errCode(forged)).toBe('CAPTCHA_REQUIRED');
    } finally {
      await cleanup(email);
      await redis.del('register:req:203.0.113.104');
    }
  });

  it('未启用（null）→ 保持旧行为：无 captchaToken 亦放行', async (ctx) => {
    if (!connected) return ctx.skip();
    const email = nextEmail();
    const { app, mailer } = makeApp(null);
    try {
      const res = await registerReq(app, email, { ip: '203.0.113.105' });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { challengeId: string }).challengeId).toBeTypeOf('string');
      expect(mailer.sent).toHaveLength(1);
    } finally {
      await cleanup(email);
      await redis.del('register:req:203.0.113.105');
    }
  });
});
