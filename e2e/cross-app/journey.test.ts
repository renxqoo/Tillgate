/**
 * 跨 app 生效链 e2e（v1 admin-api e2e-cross-app 搬迁——P7;断言语义逐条随迁）：
 *   ① 管理员重置密码 → client 旧 token /v1/me 401 + 旧密码登 401 + 新密码可登
 *   ② 管理员封禁（PATCH status:1）→ client 既有 token 即刻 401
 * 注册经 captureMailer 抓码走真实两步制;管理面经真 admin 令牌打真实 HTTP。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, jsonHeaders } from '../admin/kit.js';
import { infraReady } from '../client-journey/harness.js';
import { apiClient, registerUser, setupCrossApp, type CrossAppWorld } from './kit.js';

/** env 有值且 PG+Redis 双可达才跑（不可达优雅 skip——不误报） */
const hasInfra =
  (process.env.DB_TEST_URL != null || process.env.DATABASE_URL != null) && (await infraReady());

let world: CrossAppWorld | null = null;
let api: ReturnType<typeof apiClient> | null = null;

beforeAll(async () => {
  world = await setupCrossApp();
  if (world !== null) api = apiClient(world.client.baseUrl);
}, 120_000);

afterAll(async () => {
  if (world !== null) await world.teardown();
});

function w(): CrossAppWorld {
  if (world === null || api === null) throw new Error('cross-app world not ready');
  return world;
}

/** 两步登录走完（captureMailer 抓码）——返回新会话 token（v1「新密码可登 200」的 v2 落点） */
async function loginTwoStep(
  email: string,
  password: string,
): Promise<{ status: number; token: string | null }> {
  const first = await api!('/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  if (first.status !== 200) return { status: first.status, token: null };
  const body = (await first.json()) as { kind: string; challengeId: string };
  const verify = await api!('/v1/auth/login/verify', {
    method: 'POST',
    body: JSON.stringify({
      challengeId: body.challengeId,
      code: w().client.mailer.lastCodeOf(email),
    }),
  });
  const verified = (await verify.json()) as { token: string };
  return { status: verify.status, token: verify.status === 200 ? verified.token : null };
}

describe.skipIf(!hasInfra)('跨 app：管理动作 → 用户面即时生效（v1 e2e-cross-app 语义）', () => {
  it('管理员重置密码 → client 旧 token 401 + 旧密码登 401 + 新密码可登', async () => {
    const email = `e2e-ca-${Date.now().toString(36)}@example.com`;
    // 两步注册（真实发码经 captureMailer 抓取）→ 持有效用户会话
    const reg = await registerUser(w().client, api!, email, 'cross-app-pass-1');
    w().users.push({ id: reg.userId, email });
    expect((await api!('/v1/me', { token: reg.token })).status).toBe(200);

    // 管理面重置密码（identity user realm——推进失效线 = 全网会话下线）
    const reset = await call(w().admin, `/v1/users/${reg.userId}/set-password`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ password: 'reset-by-admin-1' }),
    });
    expect(reset.status).toBe(200);

    // 用户面：旧 token 401;旧密码死;新密码可登
    expect((await api!('/v1/me', { token: reg.token })).status).toBe(401);
    expect(
      (
        await api!('/v1/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email, password: 'cross-app-pass-1' }),
        })
      ).status,
    ).toBe(401);
    const reLogin = await loginTwoStep(email, 'reset-by-admin-1');
    expect(reLogin.status).toBe(200);
    expect((await api!('/v1/me', { token: reLogin.token! })).status).toBe(200);
  }, 60_000);

  it('管理员封禁 → client 既有 token 即刻 401', async () => {
    const email = `e2e-cb-${Date.now().toString(36)}@example.com`;
    const reg = await registerUser(w().client, api!, email, 'cross-app-pass-1');
    w().users.push({ id: reg.userId, email });
    expect((await api!('/v1/me', { token: reg.token })).status).toBe(200);

    const ban = await call(w().admin, `/v1/users/${reg.userId}`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ status: 1 }),
    });
    expect(ban.status).toBe(200);
    expect((await api!('/v1/me', { token: reg.token })).status).toBe(401);
  }, 60_000);
});
