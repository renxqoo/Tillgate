/**
 * 鉴权中间件契约（v1 app.test 鉴权全路径 + A8 爆破维度语义迁移）：
 * 双形态分派 / Key 分支守卫 / JWT 分支（app_jwt 载荷、scope 白名单、退役形态 401）/
 * 爆破计数维度（Key 双计 / JWT 只计 IP）/ 锁定拒绝。
 * 鉴权读模型与 guards 全替身（SQL/Redis 语义归各包 real 测试）。
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { errorHandler } from '@tokenlens/http';
import { GATEWAY_FACE_OVERRIDES, gatewayErrorCatalog } from '../src/http/openai-error-face';

/** 测试壳挂生产同款错误面（v1 测试直连 app 同语义） */
function withErrorFace<E extends AuthEnv>(hono: Hono<E>): Hono<E> {
  hono.onError(errorHandler({ catalog: gatewayErrorCatalog(), overrides: GATEWAY_FACE_OVERRIDES }));
  return hono;
}
import { createHash } from 'node:crypto';
import { SignJWT } from 'jose';
import {
  apiKeyMiddleware,
  type AuthEnv,
  type AuthGuards,
  type AuthReadModel,
} from '../src/http/middleware/api-key';
import type { GuardCheck } from '@tokenlens/runtime';

const SECRET = 'ab3d'.repeat(8);
const JWT = { secret: SECRET, issuer: 'ai-gateway', audience: 'ai-gateway-api', keyPrefix: 'sk_' };

const KEY = {
  keyId: 7,
  userId: 42,
  rpmLimit: 60,
  tpmLimit: 100_000,
  allowPaygFallback: true,
  userRpmLimit: 30,
  userTpmLimit: 50_000,
};

function reader(over: Partial<AuthReadModel> = {}): AuthReadModel {
  return {
    resolveKeyByHash: async (hash) => (hash === sha('sk_valid') ? KEY : null),
    resolveApp: async (appId) =>
      appId === 'app-1'
        ? { id: 5, userId: 42, scope: { rpm: 10, tpm: 20_000, models: ['m-a', 'm-b'] } }
        : null,
    ...over,
  };
}

const sha = (token: string) => createHash('sha256').update(token).digest('hex');

/** 计数阈值式替身（对齐真实 guard：窗口内 N 次失败才锁，成功清零） */
function makeGuards(keyFailLimit = 3, ipFailLimit = 5) {
  const calls = { keyFail: 0, ipFail: 0, keySuccess: 0 };
  const fails = new Map<string, number>();
  const locked = new Set<string>();
  const check = (key: string): GuardCheck =>
    locked.has(key) ? { locked: true, retryAfterSec: 60 } : { locked: false, retryAfterSec: 0 };
  return {
    calls,
    guards: {
      keyGuard: {
        isLocked: async (k: string) => check(`k:${k}`),
        recordFailure: async (k: string) => {
          calls.keyFail += 1;
          const n = (fails.get(`k:${k}`) ?? 0) + 1;
          fails.set(`k:${k}`, n);
          if (n >= keyFailLimit) locked.add(`k:${k}`);
          return { locked: n >= keyFailLimit, retryAfterSec: 60 };
        },
        recordSuccess: async (k: string) => {
          calls.keySuccess += 1;
          fails.delete(`k:${k}`);
          locked.delete(`k:${k}`);
        },
      },
      ipGuard: {
        isLocked: async (ip: string) => check(`i:${ip}`),
        recordFailure: async (ip: string) => {
          calls.ipFail += 1;
          const n = (fails.get(`i:${ip}`) ?? 0) + 1;
          fails.set(`i:${ip}`, n);
          if (n >= ipFailLimit) locked.add(`i:${ip}`);
          return { locked: n >= ipFailLimit, retryAfterSec: 60 };
        },
        recordSuccess: async (ip: string) => {
          fails.delete(`i:${ip}`);
          locked.delete(`i:${ip}`);
        },
      },
      trustedProxyHops: 0,
    } satisfies AuthGuards,
  };
}

function app(readerDeps: AuthReadModel, guards?: AuthGuards) {
  const hono = withErrorFace(new Hono<AuthEnv>());
  hono.use('/v1/*', apiKeyMiddleware(readerDeps, guards, JWT));
  hono.get('/v1/whoami', (c) => c.json(c.get('auth') ?? null));
  return hono;
}

const get = (a: Hono<AuthEnv>, path: string, token?: string) =>
  a.request(path, token != null ? { headers: { authorization: `Bearer ${token}` } } : {});

const appJwt = (payload: Record<string, unknown>) =>
  new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(JWT.issuer)
    .setAudience(JWT.audience)
    .sign(new TextEncoder().encode(SECRET));

describe('Key 分支', () => {
  it('有效 Key → 全维上下文（rpm/tpm/user 并罚字段）', async () => {
    const res = await get(app(reader()), '/v1/whoami', 'sk_valid');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      userId: 42,
      apiKeyId: 7,
      appId: null,
      rpmLimit: 60,
      tpmLimit: 100_000,
      userRpmLimit: 30,
      userTpmLimit: 50_000,
      allowedModels: null,
    });
  });

  it('缺头 / 未知 Key → 401；未知 Key 双计数（keyHash + IP）', async () => {
    const { guards, calls } = makeGuards();
    const a = app(reader(), guards);
    expect((await get(a, '/v1/whoami')).status).toBe(401);
    expect((await get(a, '/v1/whoami', 'sk_unknown')).status).toBe(401);
    expect(calls.keyFail).toBe(1);
    expect(calls.ipFail).toBe(1);
    expect((await get(a, '/v1/whoami', 'sk_valid')).status).toBe(200);
    expect(calls.keySuccess).toBe(1);
  });

  it('Key 维锁定 → 401 带 retry 提示（阈值内不误伤他人 Key）', async () => {
    const { guards, calls } = makeGuards(3, 100); // IP 维抬高：隔离 Key 维行为
    const a = app(reader(), guards);
    for (let i = 0; i < 3; i++) await get(a, '/v1/whoami', 'sk_bad'); // 达阈值锁定
    expect(calls.keyFail).toBe(3);
    const lockedRes = await get(a, '/v1/whoami', 'sk_bad');
    expect(lockedRes.status).toBe(401);
    expect(await lockedRes.text()).toContain('locked');
    const res = await get(a, '/v1/whoami', 'sk_valid');
    expect(res.status).toBe(200);
  });
});

describe('JWT 分支', () => {
  it('app_jwt：属主校验 + scope 白名单 + rpm/tpm', async () => {
    const token = await appJwt({ sub: '42', app_id: 'app-1', typ: 'app_jwt' });
    const res = await get(app(reader()), '/v1/whoami', token);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      userId: 42,
      apiKeyId: null,
      appId: 5,
      allowedModels: ['m-a', 'm-b'],
      rpmLimit: 10,
      tpmLimit: 20_000,
    });
  });

  it('属主不匹配（sub ≠ app.userId）→ 401', async () => {
    const token = await appJwt({ sub: '999', app_id: 'app-1', typ: 'app_jwt' });
    expect((await get(app(reader()), '/v1/whoami', token)).status).toBe(401);
  });

  it('退役形态（playground 等 typ）签名合法也 401（v1 final-hardening 锁）', async () => {
    const token = await appJwt({ sub: '42', typ: 'playground' });
    expect((await get(app(reader()), '/v1/whoami', token)).status).toBe(401);
  });

  it('验签失败计 IP 维失败（A8：JWT 只计 IP，不触 keyGuard）', async () => {
    const { guards, calls } = makeGuards();
    const a = app(reader(), guards);
    const forged = await new SignJWT({ sub: '42', typ: 'app_jwt' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(JWT.issuer)
      .setAudience(JWT.audience)
      .sign(new TextEncoder().encode('wrong-secret'));
    expect((await get(a, '/v1/whoami', forged)).status).toBe(401);
    expect(calls.ipFail).toBe(1);
    expect(calls.keyFail).toBe(0);
  });

  it('IP 维锁定后合法 JWT 也拒（锁优先于验签）', async () => {
    const { guards } = makeGuards(100, 3); // Key 维抬高：隔离 IP 维行为
    const a = app(reader(), guards);
    for (let i = 0; i < 3; i++) await get(a, '/v1/whoami', 'not-a-key-nor-jwt'); // IP 维达阈值锁
    const token = await appJwt({ sub: '42', app_id: 'app-1', typ: 'app_jwt' });
    const res = await get(a, '/v1/whoami', token);
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('locked');
  });
});
