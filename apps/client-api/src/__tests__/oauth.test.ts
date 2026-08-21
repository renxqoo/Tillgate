/**
 * OAuth 集成套件（真 PG + fetch 替身 + 端点覆盖）：
 * 关键不变量：issuer 物理隔离不合并本地账号；state 双提交防 login-CSRF；
 * Redis 单次消费；封禁 403 不被兜底吞成 502；token 经 URL fragment 回传。
 */
import { describe, expect, it } from 'vitest';
import { randomInt } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { users } from '@ai-gateway/db';
import { systemContext } from '@ai-gateway/service';
import { verifySession } from '@ai-gateway/identity';
import {
  createOAuthService,
  type OAuthStateStore,
  type OAuthServiceDeps,
} from '../services/oauth.service.js';
import { oauthRoutes } from '../routes/oauth.js';
import { db, email, expectAmountEq, balanceOf, newUser, trackUser, uid, wallet } from './helpers.js';

const ctx = systemContext('cav2-oauth');
const JWT = 'oauth-test-secret-0123456789abcdef';
const ENDPOINTS = {
  authorizeUrl: 'https://oauth.test/authorize',
  tokenUrl: 'https://oauth.test/token',
  profileUrl: 'https://oauth.test/user',
  emailsUrl: 'https://oauth.test/emails',
};

/** 内存单次 state 存储（Redis GETDEL 语义） */
function memoryStateStore(): OAuthStateStore {
  const store = new Map<string, { provider: 'github' | 'google'; next: string }>();
  return {
    async save(state, payload) {
      store.set(state, payload);
    },
    async consume(state) {
      const v = store.get(state) ?? null;
      store.delete(state);
      return v;
    },
  };
}

/** fetch 替身：token → github profile → emails 三段式 */
function fakeFetch(subjectId = `gh-${randomInt(1, 2_000_000_000)}`, opts: { email?: string; name?: string } = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    calls.push(href);
    if (href.startsWith(ENDPOINTS.tokenUrl)) {
      return new Response(JSON.stringify({ access_token: 'at-xyz' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (href.startsWith(ENDPOINTS.profileUrl)) {
      return new Response(
        JSON.stringify({ id: Number(subjectId.replace(/\D/g, '')) || 42, login: 'octocat', name: opts.name ?? null }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (href.startsWith(ENDPOINTS.emailsUrl)) {
      return new Response(
        JSON.stringify([
          { email: 'secondary@gh.com', primary: false, verified: true },
          { email: opts.email ?? 'octo@gh.com', primary: true, verified: true },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function buildService(overrides: Partial<OAuthServiceDeps> = {}) {
  const fake = fakeFetch();
  const service = createOAuthService({
    db,
    wallet,
    jwtSecret: JWT,
    sessionTtlSeconds: 600,
    frontendUrl: 'https://console.example.com',
    apiBase: 'https://api.example.com',
    providers: {
      github: { clientId: 'cid', clientSecret: 'sec', endpoints: ENDPOINTS },
    },
    stateStore: memoryStateStore(),
    giftAmount: '0',
    fetchImpl: fake.fetchImpl,
    ...overrides,
  });
  return { service, fake };
}

describe('授权跳转', () => {
  it('authorize：302 URL 含 client_id/redirect_uri/scope/state；next 站内相对路径', async () => {
    const { service } = buildService();
    const { url, state } = await service.authorize('github', '/billing?x=1');
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(ENDPOINTS.authorizeUrl);
    expect(parsed.searchParams.get('client_id')).toBe('cid');
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://api.example.com/v1/oauth/github/callback');
    expect(parsed.searchParams.get('scope')).toBe('read:user user:email');
    expect(parsed.searchParams.get('state')).toBe(state);
    expect(state).toMatch(/^[0-9a-f]{48}$/);
  });

  it('未配置 provider → 404 oauth_not_configured', async () => {
    const { service } = buildService({ providers: {} });
    await expect(service.authorize('github', '/')).rejects.toMatchObject({
      status: 404,
      code: 'oauth_not_configured',
    });
    expect(service.providers()).toEqual([]);
  });
});

describe('回调（login-CSRF 防护 + find-or-create）', () => {
  it('happy path：state 双提交 → 建号 → token 走 URL fragment', async () => {
    const { service } = buildService({ giftAmount: '3' });
    const { state } = await service.authorize('github', '/dashboard');

    const result = await service.callback(ctx, {
      provider: 'github',
      code: 'auth-code-1',
      state,
      cookieState: state,
    });
    expect(result.created).toBe(true);
    await trackUser(result.userId);
    expect(result.redirectUrl.startsWith('https://console.example.com/dashboard#token=')).toBe(true);
    // fragment 里的 token 是有效用户会话
    const token = result.redirectUrl.split('#token=')[1]!;
    const payload = await verifySession(decodeURIComponent(token), JWT, 'user');
    expect(payload.sub).toBe(String(result.userId));
    // 建号赠送（与本地注册同 refKey 口径）
    expectAmountEq(await balanceOf(result.userId), '3');
  });

  it('二次登录同 subject：不重复建号、不再赠送', async () => {
    const service = buildService({ giftAmount: '3' }).service;
    // 双提交流程 × 2
    const a = await service.authorize('github', '/');
    const r1 = await service.callback(ctx, { provider: 'github', code: 'c1', state: a.state, cookieState: a.state });
    await trackUser(r1.userId);
    const b = await service.authorize('github', '/');
    const r2 = await service.callback(ctx, { provider: 'github', code: 'c2', state: b.state, cookieState: b.state });
    expect(r2.created).toBe(false);
    expect(r2.userId).toBe(r1.userId);
    expectAmountEq(await balanceOf(r1.userId), '3'); // 只送一次
  });

  it('cookie state 不匹配 → 403；Redis 单次消费后重放 → 410', async () => {
    const { service } = buildService();
    const { state } = await service.authorize('github', '/');
    await expect(
      service.callback(ctx, { provider: 'github', code: 'c', state, cookieState: 'other' }),
    ).rejects.toMatchObject({ status: 403, code: 'oauth_state_mismatch' });
    await expect(
      service.callback(ctx, { provider: 'github', code: 'c', state, cookieState: undefined }),
    ).rejects.toMatchObject({ status: 403, code: 'oauth_state_mismatch' });

    const ok = await service.callback(ctx, { provider: 'github', code: 'c', state, cookieState: state });
    await trackUser(ok.userId);
    // state 已被消费（单次）
    await expect(
      service.callback(ctx, { provider: 'github', code: 'c', state, cookieState: state }),
    ).rejects.toMatchObject({ status: 410, code: 'oauth_state_expired' });
  });

  it('封禁 OAuth 账号 → 403（不被 502 兜底吞掉）', async () => {
    const { service } = buildService();
    const { state } = await service.authorize('github', '/');
    const ok = await service.callback(ctx, { provider: 'github', code: 'c', state, cookieState: state });
    await trackUser(ok.userId);
    await db.update(users).set({ status: 1 }).where(eq(users.id, ok.userId));

    const s2 = await service.authorize('github', '/');
    await expect(
      service.callback(ctx, { provider: 'github', code: 'c', state: s2.state, cookieState: s2.state }),
    ).rejects.toMatchObject({ status: 403, code: 'account_unavailable' });
  });

  it('上游 token 交换失败 → 502 oauth_exchange_failed', async () => {
    const broken = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    const { service } = buildService({ fetchImpl: broken });
    const { state } = await service.authorize('github', '/');
    await expect(
      service.callback(ctx, { provider: 'github', code: 'c', state, cookieState: state }),
    ).rejects.toMatchObject({ status: 502, code: 'oauth_exchange_failed' });
  });

  it('issuer 物理隔离：OAuth 账号与同邮箱本地账号不合并', async () => {
    const local = await newUser(); // issuer='local'
    const mail = email();
    await db.update(users).set({ email: mail }).where(eq(users.id, local.id));
    // GitHub 主邮箱 = 本地账号邮箱
    const fake = fakeFetch('gh-999', { email: mail });
    const svc = createOAuthService({
      db,
      wallet,
      jwtSecret: JWT,
      sessionTtlSeconds: 600,
      frontendUrl: 'https://console.example.com',
      apiBase: 'https://api.example.com',
      providers: { github: { clientId: 'cid', clientSecret: 'sec', endpoints: ENDPOINTS } },
      stateStore: memoryStateStore(),
      giftAmount: '0',
      fetchImpl: fake.fetchImpl,
    });
    const { state } = await svc.authorize('github', '/');
    const result = await svc.callback(ctx, { provider: 'github', code: 'c', state, cookieState: state });
    await trackUser(result.userId);
    expect(result.userId).not.toBe(local.id); // 不同账号（防劫持）
  });
});

describe('HTTP 面（oauthRoutes）', () => {
  it('providers 端点 / authorize 302 + state cookie / callback 302 前端', async () => {
    const unique = fakeFetch('gh-' + Math.floor(Math.random() * 1e9));
    const service = createOAuthService({
      db,
      wallet,
      jwtSecret: JWT,
      sessionTtlSeconds: 600,
      frontendUrl: 'https://console.example.com',
      apiBase: 'https://api.example.com',
      providers: { github: { clientId: 'cid', clientSecret: 'sec', endpoints: ENDPOINTS } },
      stateStore: memoryStateStore(),
      giftAmount: '0',
      fetchImpl: unique.fetchImpl,
    });
    const app = oauthRoutes(service, { secureCookie: false });

    const providersRes = await app.request('/v1/oauth/providers');
    expect(await providersRes.json()).toEqual({ providers: ['github'] });

    const authRes = await app.request('/v1/oauth/github/authorize?next=/x');
    expect(authRes.status).toBe(302);
    const stateCookie = authRes.headers
      .getSetCookie()
      .find((c) => c.startsWith('ag_oauth_state='))!
      .split(';')[0]!
      .split('=')[1]!;
    const state = new URL(authRes.headers.get('location')!).searchParams.get('state')!;
    expect(stateCookie).toBe(state);

    const cbRes = await app.request(`/v1/oauth/github/callback?code=c&state=${state}`, {
      headers: { cookie: `ag_oauth_state=${stateCookie}` },
    });
    expect(cbRes.status).toBe(302);
    expect(cbRes.headers.get('location')!.startsWith('https://console.example.com/x#token=')).toBe(true);
    void uid;
  });

  it('未知 provider → 404', async () => {
    const { service } = buildService();
    const app = oauthRoutes(service, { secureCookie: false });
    expect((await app.request('/v1/oauth/gitlab/authorize')).status).toBe(404);
  });
});
