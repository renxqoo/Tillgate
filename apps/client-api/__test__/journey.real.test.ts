/**
 * 端到端用户旅程（test:real 通道；真实 PG + Redis + 真实 HTTP 进程）：
 * MIGRATION §6 行为对照清单的核心链在一条用例里顺序核销——注册两步制（capture
 * mailer 收码）→ 建号赠送 → 资料改显 → Key 全生命周期 → 钱包/用量/定价/推荐只读面 →
 * 兑换失败语义 → 登出即时吊销 → 两级登录 → 改密全网下线 → 新密码复登。
 * 数据自清理（FK 逆序 best-effort）；跨进程旅程（含 OAuth/支付回调/gateway 联动）
 * 仍归根 e2e/（MIGRATION §8 待办）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import pg from 'pg';
// pg 仅用于探测/无类型依赖（db 包不透出裸客户端）
import { sql } from 'drizzle-orm';
import { createRedisClient, assertRedisReachable } from '@tokenlens/runtime';
import { loadClientApiConfig } from '../src/config.js';
import { assembleClientApi, type ClientApiAssembly } from '../src/assembly.js';
import { createClientApiApp } from '../src/app.js';
import type { Mailer } from '@tokenlens/identity';

const env: NodeJS.ProcessEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
  JWT_SECRET: process.env.JWT_SECRET ?? 'journey-jwt-secret-0123456789ab',
  CLIENT_CODE_PEPPER: process.env.CLIENT_CODE_PEPPER ?? 'journey-pepper-0123456789ab',
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? 'journey-enc-key-0123456789ab',
  // 旅程内同邮箱多次发码——冷却与注册限频放宽为测试口径（不改产品默认）
  CLIENT_CHALLENGE_COOLDOWN_MS: '1',
  REGISTER_IP_LIMIT_PER_HOUR: '1000',
};

async function infraReady(): Promise<boolean> {
  try {
    const redis = createRedisClient(env.REDIS_URL as string, {
      serviceName: 'client-api-journey-probe',
      logThrottleMs: 1_000,
    });
    await assertRedisReachable(redis, 'client-api-journey-probe', env.REDIS_URL as string, 3_000);
    await redis.quit().catch(() => undefined);
    const client = new pg.Client({ connectionString: env.DATABASE_URL });
    await client.connect();
    await client.query('select 1');
    await client.end();
    return true;
  } catch {
    return false;
  }
}

const context = describe.skipIf(!(await infraReady()));

/** capture mailer：identity Mailer port 的测试替身（按邮箱记录最近验证码） */
function createCaptureMailer(): Mailer & { lastCodeOf(email: string): string | null } {
  const codes = new Map<string, string>();
  return {
    async sendLoginCode(to, code) {
      codes.set(to, code);
    },
    lastCodeOf(email) {
      return codes.get(email) ?? null;
    },
  };
}

let assembly: ClientApiAssembly | null = null;
let server: { address(): { port: number } | string | null; close(cb: () => void): void } | null =
  null;
let baseUrl = '';
const mailer = createCaptureMailer();
const runTag = `e2e-ca-${Date.now().toString(36)}`;
const email = `${runTag}@example.com`;
const password = 'journey-password-123';
let journeyUserId = 0;

function api(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<Response> {
  const { token, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token != null) headers.set('authorization', `Bearer ${token}`);
  if (rest.body != null && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return fetch(`${baseUrl}${path}`, { ...rest, headers });
}

/** FK 逆序 best-effort 清理（无级联删除；失败仅记录不阻断） */
async function cleanup(db: ClientApiAssembly['db']) {
  if (journeyUserId === 0) return;
  const uid = journeyUserId;
  const statements = [
    sql`delete from wallet_legs where transaction_id in (
          select t.id from wallet_transactions t
          where (t.ref_type = 'gift' and t.ref_id = ${'signup:' + uid})
             or t.ref_id in (${'referral-signup:' + uid + ':inviter'}, ${'referral-signup:' + uid + ':invitee'}))`,
    sql`delete from wallet_transactions where (ref_type = 'gift' and ref_id = ${'signup:' + uid})
        or ref_id in (${'referral-signup:' + uid + ':inviter'}, ${'referral-signup:' + uid + ':invitee'})`,
    sql`delete from wallet_accounts where user_id = ${uid}`,
    sql`delete from api_keys where user_id = ${uid}`,
    sql`delete from identity_passwords where user_id = ${uid}`,
    sql`delete from identity_credentials where user_id = ${uid}`,
    sql`delete from identity_session_anchors where user_id = ${uid}`,
    sql`delete from identity_challenges where identifier_value = ${email}`,
    sql`delete from users where id = ${uid}`,
  ];
  for (const statement of statements) {
    await db.execute(statement).catch(() => undefined);
  }
}

beforeAll(async () => {
  const config = loadClientApiConfig(env);
  assembly = await assembleClientApi(config, { mailer });
  const app = createClientApiApp(assembly.deps);
  server = serve({ fetch: app.fetch, port: 0 });
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('journey server failed to bind');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (assembly != null) await cleanup(assembly.db);
  await new Promise<void>((resolve) => {
    if (server == null) return resolve();
    server.close(() => resolve());
  });
  if (assembly != null) {
    await assembly.redis.quit().catch(() => undefined);
    await assembly.otel.shutdown().catch(() => undefined);
    const { closeDb } = await import('@tokenlens/db');
    await closeDb(assembly.db);
  }
});

context('用户旅程端到端', () => {
  it('注册 → 生命周期 → 登出吊销 → 两级登录 → 改密下线（全链核销）', async () => {
    // 0) 存活与能力探测（capture mailer 在 → 两级登录开启）
    expect((await api('/healthz')).status).toBe(200);
    const caps = (await (await api('/v1/auth/capabilities')).json()) as {
      registerEnabled: boolean;
      emailCodeRequired: boolean;
    };
    expect(caps.registerEnabled).toBe(true);
    expect(caps.emailCodeRequired).toBe(true);

    // 1) 注册两步制：发码 → capture 收码 → verify 建+号绑凭据+赠送+签会话
    const reg = await api('/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    expect(reg.status).toBe(200);
    const regBody = (await reg.json()) as { kind: string; challengeId: string };
    expect(regBody.kind).toBe('code_required');
    const code = mailer.lastCodeOf(email);
    expect(code).toMatch(/^\d{6}$/);

    const ver = await api('/v1/auth/register/verify', {
      method: 'POST',
      body: JSON.stringify({ challengeId: regBody.challengeId, code }),
    });
    expect(ver.status).toBe(201);
    const verBody = (await ver.json()) as {
      kind: string;
      token: string;
      userId: number;
      email: string;
      gifted: boolean;
    };
    expect(verBody.kind).toBe('success');
    expect(verBody.email).toBe(email);
    expect(typeof verBody.gifted).toBe('boolean');
    journeyUserId = verBody.userId;
    let token = verBody.token;

    // 2) 挑战单次消费：重放同 challengeId → 400
    const replay = await api('/v1/auth/register/verify', {
      method: 'POST',
      body: JSON.stringify({ challengeId: regBody.challengeId, code }),
    });
    expect(replay.status).toBe(400);

    // 3) 资料面：/v1/me 富化 + 改显名
    const me = (await (await api('/v1/me', { token })).json()) as {
      id: number;
      displayName: string | null;
      accounts: unknown[];
    };
    expect(me.id).toBe(journeyUserId);
    expect(Array.isArray(me.accounts)).toBe(true);
    const rename = await api('/v1/me/display-name', {
      method: 'PATCH',
      token,
      body: JSON.stringify({ displayName: 'Journey User' }),
    });
    expect(await rename.json()).toEqual({ displayName: 'Journey User' });

    // 4) Key 全生命周期：创建（明文一次）→ 列表 → 修补 → 轮换 → 吊销
    const created = await api('/v1/keys', {
      method: 'POST',
      token,
      body: JSON.stringify({ name: 'journey-key', rpmLimit: 10, dailySpendLimit: '5' }),
    });
    expect(created.status).toBe(201);
    const keyBody = (await created.json()) as { id: number; plaintext: string };
    expect(keyBody.plaintext.startsWith('ag_')).toBe(true);

    const listed = (await (await api('/v1/keys', { token })).json()) as {
      rows: Array<{ id: number; name: string }>;
      total: number;
    };
    expect(listed.rows.some((r) => r.id === keyBody.id)).toBe(true);

    const patched = await api(`/v1/keys/${keyBody.id}`, {
      method: 'PATCH',
      token,
      body: JSON.stringify({ name: 'journey-key-2' }),
    });
    expect(patched.status).toBe(200);

    const rotated = await api(`/v1/keys/${keyBody.id}/rotate`, { method: 'POST', token });
    expect(rotated.status).toBe(201);
    const rotatedBody = (await rotated.json()) as { plaintext: string; id: number };
    expect(rotatedBody.plaintext).not.toBe(keyBody.plaintext);

    const revoked = await api(`/v1/keys/${rotatedBody.id}`, { method: 'DELETE', token });
    expect(await revoked.json()).toEqual({ id: rotatedBody.id });

    // 5) 只读面：钱包/用量/定价/套餐/组织/推荐
    expect((await api('/v1/wallet/accounts', { token })).status).toBe(200);
    expect((await api('/v1/wallet/statement?limit=5', { token })).status).toBe(200);
    expect((await api('/v1/usage', { token })).status).toBe(200);
    expect((await api('/v1/usage/by-model', { token })).status).toBe(200);
    const summaryRes = await api('/v1/usage/summary', { token });
    expect(summaryRes.status).toBe(200);
    const summary = (await summaryRes.json()) as { list: unknown[] };
    expect(Array.isArray(summary.list)).toBe(true);
    expect((await api('/v1/usage/rate', { token })).status).toBe(200);
    expect((await api('/v1/pricing')).status).toBe(200);
    expect((await api('/v1/pricing/personal', { token })).status).toBe(200);
    expect((await api('/v1/plans')).status).toBe(200);
    const orgs = (await (await api('/v1/orgs', { token })).json()) as { rows: unknown[] };
    expect(orgs.rows).toHaveLength(0);
    const referralConfig = (await (await api('/v1/referrals/config', { token })).json()) as {
      enabled: boolean;
    };
    expect(typeof referralConfig.enabled).toBe('boolean');
    const referrals = (await (await api('/v1/referrals', { token })).json()) as {
      affCode: string;
      totalCommission: string;
    };
    expect(referrals.affCode.length).toBeGreaterThan(0);
    expect(referrals.totalCommission).toBe('0');

    // 6) 兑换失败语义：未知码 → 404 billing.invalid_code
    const redeem = await api('/v1/redeem', {
      method: 'POST',
      token,
      body: JSON.stringify({ code: 'E2E-NO-SUCH-CODE' }),
    });
    expect(redeem.status).toBe(404);
    expect(((await redeem.json()) as { error: { code: string } }).error.code).toBe('billing.invalid_code');

    // 7) 支付面：未配渠道 → 空目录；订单列表空
    const channels = (await (await api('/v1/payments/channels', { token })).json()) as {
      channels: unknown[];
    };
    expect(channels.channels).toHaveLength(0);
    const orders = (await (await api('/v1/payments/orders', { token })).json()) as { rows: unknown[] };
    expect(orders.rows).toHaveLength(0);

    // 8) 登出即时吊销：jti 黑名单生效，旧 token 立即 401
    expect(await (await api('/v1/auth/logout', { method: 'POST', token })).json()).toEqual({ ok: true });
    expect((await api('/v1/me', { token })).status).toBe(401);

    // 9) 防枚举：错密码统一 401（失败计数进入双闸——阈值内不锁）
    const wrong = await api('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'wrong-password-1' }),
    });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe(
      'identity.invalid_credentials',
    );

    // 10) 两级登录：login 发码 → capture 收码 → verify 签发
    const login = await api('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    expect(login.status).toBe(200);
    const loginBody = (await login.json()) as { kind: string; challengeId: string };
    expect(loginBody.kind).toBe('code_required');
    const loginCode = mailer.lastCodeOf(email);
    expect(loginCode).toMatch(/^\d{6}$/);
    const loginVer = await api('/v1/auth/login/verify', {
      method: 'POST',
      body: JSON.stringify({ challengeId: loginBody.challengeId, code: loginCode }),
    });
    expect(loginVer.status).toBe(200);
    const loginVerBody = (await loginVer.json()) as { token: string; userId: number };
    expect(loginVerBody.userId).toBe(journeyUserId);
    token = loginVerBody.token;

    // 11) 改密：返回新 token；旧 token 全网下线（吊销锚点）；新密码可复登
    const changed = await api('/v1/auth/password', {
      method: 'POST',
      token,
      body: JSON.stringify({ oldPassword: password, newPassword: 'journey-password-456' }),
    });
    expect(changed.status).toBe(200);
    const changedBody = (await changed.json()) as { token: string };
    expect((await api('/v1/me', { token })).status).toBe(401);
    expect((await api('/v1/me', { token: changedBody.token })).status).toBe(200);

    const relogin = await api('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'journey-password-456' }),
    });
    const reloginBody = (await relogin.json()) as { kind: string; challengeId: string };
    expect(reloginBody.kind).toBe('code_required');
    const reloginVer = await api('/v1/auth/login/verify', {
      method: 'POST',
      body: JSON.stringify({ challengeId: reloginBody.challengeId, code: mailer.lastCodeOf(email) }),
    });
    expect(reloginVer.status).toBe(200);
  }, 120_000);
});
