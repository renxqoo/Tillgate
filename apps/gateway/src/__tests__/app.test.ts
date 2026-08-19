/**
 * app 层测试（真实 PG）：健康检查 / 错误信封翻译契约 / API Key 鉴权全路径。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '@ai-gateway/db';
import { apiKeys, users } from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import { createHash } from 'node:crypto';
import {
  DailySpendLimitExceededError,
  FrozenAccountError,
  IdempotencyConflictError,
  InvalidRefError,
  WalletInvariantError,
} from '@ai-gateway/domain';
import { SignJWT } from 'jose';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { createApp } from '../app.js';
import { mapErrorToHttp, UnauthorizedError } from '../http/error-map.js';
import { apiKeyMiddleware, type AuthEnv } from '../middleware/api-key.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const app = createApp({ db, oauth: { jwtSecret: 'gw-test-secret-0123456789abcdef', tokenTtlSeconds: 3_600 } });
const createdUsers: number[] = [];
const createdKeys: number[] = [];

async function newUser(): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ issuer: 'v2ga', subject: `v2ga-${randomUUID()}`, identityProvider: 'local' })
    .returning({ id: users.id });
  createdUsers.push(row!.id);
  return row!.id;
}

async function newKey(userId: number, overrides: Record<string, unknown> = {}): Promise<string> {
  const raw = `ag_${randomUUID().replace(/-/g, '')}`;
  const [row] = await db
    .insert(apiKeys)
    .values({
      keyHash: createHash('sha256').update(raw).digest('hex'),
      keyPreview: `ag_****${raw.slice(-4)}`,
      userId,
      name: 'v2ga-key',
      ...overrides,
    })
    .returning({ id: apiKeys.id });
  createdKeys.push(row!.id);
  return raw;
}

afterAll(async () => {
  // 原生参数化清理（app 层零 drizzle import——SQL 归 repository 的边界同样适用于测试）
  if (createdKeys.length) await db.$client.query('delete from api_keys where id = any($1)', [createdKeys]);
  if (createdUsers.length) await db.$client.query('delete from users where id = any($1)', [createdUsers]);
  await db.$client.end().catch(() => {});
});

describe('healthz', () => {
  it('DB 通则 200', async () => {
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('错误信封翻译契约', () => {
  const cases: Array<[unknown, number, string]> = [
    [new InvalidRefError('invalid_ref_type'), 400, 'invalid_ref'],
    [new DailySpendLimitExceededError(1, '1', '2'), 402, 'daily_spend_limit_exceeded'],
    [new FrozenAccountError('a1'), 403, 'account_frozen'],
    [new IdempotencyConflictError('t', 'r', 'k'), 409, 'idempotency_conflict'],
    [new WalletInvariantError('x'), 500, 'invariant_violated'],
    [new UnauthorizedError(), 401, 'unauthorized'],
    [new Error('boom'), 500, 'internal_error'],
  ];
  for (const [error, status, code] of cases) {
    it(`${(error as Error).name} → ${status} ${code}`, () => {
      expect(mapErrorToHttp(error)).toMatchObject({ status, code });
    });
  }

  it('onError 渲染信封形状', async () => {
    const probe = new Hono<AuthEnv>();
    probe.onError((error, c) => {
      const mapped = mapErrorToHttp(error);
      return c.json({ error: { code: mapped.code, message: mapped.message } }, mapped.status as ContentfulStatusCode);
    });
    probe.get('/boom', () => {
      throw new FrozenAccountError('a1');
    });
    const res = await probe.request('/boom');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: 'account_frozen', message: expect.stringContaining('frozen') } });
  });
});

describe('API Key 鉴权', () => {
  const guard = (key?: string) => {
    const probe = new Hono<AuthEnv>();
    probe.onError((error, c) => {
      const mapped = mapErrorToHttp(error);
      return c.json({ error: { code: mapped.code, message: mapped.message } }, mapped.status as ContentfulStatusCode);
    });
    probe.use('*', apiKeyMiddleware(db, undefined, 'gw-test-secret-0123456789abcdef'));
    probe.get('/whoami', (c) => c.json({ userId: c.get('auth')!.userId, apiKeyId: c.get('auth')!.apiKeyId }));
    return probe.request('/whoami', key ? { headers: { authorization: `Bearer ${key}` } } : {});
  };

  it('有效 Key → 200 携带鉴权上下文', async () => {
    const user = await newUser();
    const raw = await newKey(user);
    const res = await guard(raw);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ userId: user });
  });

  it('缺头 / 非 ag_ 前缀 / 未知 Key → 401 unauthorized', async () => {
    expect((await guard()).status).toBe(401);
    expect((await guard('sk_wrong_prefix')).status).toBe(401);
    expect((await guard(`ag_${randomUUID()}`)).status).toBe(401);
  });

  it('吊销 / 过期 Key → 401（repo 守卫口径）', async () => {
    const user = await newUser();
    const revoked = await newKey(user, { status: 1 });
    const expired = await newKey(user, { expiresAt: new Date(Date.now() - 1_000) });
    expect((await guard(revoked)).status).toBe(401);
    expect((await guard(expired)).status).toBe(401);
  });

  it('未注册的 /v1/* 路径 → 404（鉴权按已注册端点挂载——老网关语义）', async () => {
    const res = await app.request('/v1/ping');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });
});

describe('JWT 凭证爆破锁（终审修复：修复前 JWT 分支不查锁不计失败 = 未认证无限打点）', () => {
  const probeWith = (ipGuard: { isLocked: (ip: string) => Promise<{ locked: boolean; retryAfterSec: number }>; recordFailure: (ip: string) => Promise<{ locked: boolean; retryAfterSec: number }> }) => {
    const probe = new Hono<AuthEnv>();
    probe.onError((error, c) => {
      const mapped = mapErrorToHttp(error);
      return c.json({ error: { code: mapped.code, message: mapped.message } }, mapped.status as ContentfulStatusCode);
    });
    probe.use('*', apiKeyMiddleware(db, {
      keyGuard: {
        isLocked: async () => ({ locked: false, retryAfterSec: 0 }),
        recordFailure: async () => ({ locked: false, retryAfterSec: 0 }),
        recordSuccess: async () => {},
      },
      ipGuard,
      trustedProxyHops: 0,
    }, 'gw-test-secret-0123456789abcdef'));
    probe.get('/whoami', (c) => c.json({ userId: c.get('auth')?.userId }));
    return probe;
  };

  it('伪造 JWT 连续失败计数 → 达阈锁定；锁定后合法 JWT 也先被锁拒绝', async () => {
    let failures = 0;
    let locked = false;
    const probe = probeWith({
      isLocked: async () => ({ locked, retryAfterSec: 42 }),
      recordFailure: async () => {
        failures += 1;
        if (failures >= 3) locked = true;
        return { locked, retryAfterSec: 42 };
      },
    });
    const badJwt = () => probe.request('/whoami', { headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.bad.bad' } });
    expect((await badJwt()).status).toBe(401);
    expect((await badJwt()).status).toBe(401);
    expect((await badJwt()).status).toBe(401);
    expect(failures).toBe(3); // 修复前：JWT 分支失败不计数（failures 恒 0）
    // 锁定后：签名完全合法的 JWT 也在验签前被锁拒绝（不再触达 DB）
    const user = await newUser();
    const good = await new SignJWT({ typ: 'playground', sub: String(user) })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('ai-gateway')
      .setAudience('ai-gateway-api')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('gw-test-secret-0123456789abcdef'));
    const res = await probe.request('/whoami', { headers: { authorization: `Bearer ${good}` } });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('source locked');
  });

  it('合法 JWT 鉴权成功 → 不计失败（爆破锁不误伤正常流量）', async () => {
    let failures = 0;
    const probe = probeWith({
      isLocked: async () => ({ locked: false, retryAfterSec: 0 }),
      recordFailure: async () => { failures += 1; return { locked: false, retryAfterSec: 0 }; },
    });
    const user = await newUser();
    const good = await new SignJWT({ typ: 'playground', sub: String(user) })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('ai-gateway')
      .setAudience('ai-gateway-api')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('gw-test-secret-0123456789abcdef'));
    const res = await probe.request('/whoami', { headers: { authorization: `Bearer ${good}` } });
    expect(res.status).toBe(200);
    expect(failures).toBe(0);
  });
});
