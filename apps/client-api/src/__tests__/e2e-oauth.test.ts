/**
 * E2E ③ OAuth 全链（本地 mock GitHub 服务 + 真重定向流）：
 * providers → authorize 302（state cookie）→ 手动走「用户在 GitHub 登录」→
 * callback → 302 前端 #token= → token 调 /v1/me。
 * 攻击面：state 不匹配 403 / 未配置 provider 404 / 封禁 403。
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '@ai-gateway/db';
import {
  E2EFixtures,
  e2eDb,
  e2eBaseConfig,
  errCode,
  http,
  startClientApi,
  type E2EClientApi,
} from './e2e-kit.js';

let api: E2EClientApi;
let fx: E2EFixtures;
let github: Server;
let githubUrl = '';

/** 本地 mock GitHub：authorize 静态 200 / token / user / user/emails */
function startMockGithub(subjectId: string): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    if (url.pathname === '/login/oauth/authorize') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('mock github login page');
      return;
    }
    if (url.pathname === '/login/oauth/access_token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'mock-access-token' }));
      return;
    }
    if (url.pathname === '/user') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: Number(subjectId), login: 'e2e-octocat', name: null }));
      return;
    }
    if (url.pathname === '/user/emails') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify([
          { email: 'secondary@mock.gh', primary: false, verified: true },
          { email: 'e2e-octo@mock.gh', primary: true, verified: true },
        ]),
      );
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      githubUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
      resolve(server);
    });
  });
}

beforeAll(async () => {
  const db = e2eDb();
  github = await startMockGithub('424242');
  api = await startClientApi(db, {
    ...e2eBaseConfig(),
    OAUTH_FRONTEND_URL: 'https://console.e2e.test',
    OAUTH_API_BASE: 'http://api.e2e.test',
    OAUTH_GITHUB_CLIENT_ID: 'e2e-client-id',
    OAUTH_GITHUB_CLIENT_SECRET: 'e2e-client-secret',
    OAUTH_GITHUB_ENDPOINTS_JSON: JSON.stringify({
      authorizeUrl: `${githubUrl}/login/oauth/authorize`,
      tokenUrl: `${githubUrl}/login/oauth/access_token`,
      profileUrl: `${githubUrl}/user`,
      emailsUrl: `${githubUrl}/user/emails`,
    }),
  } as never);
  fx = new E2EFixtures(db);
});

afterAll(async () => {
  await fx.cleanup();
  await api.stop();
  await api.db.$client.end().catch(() => {});
  await new Promise<void>((resolve) => github.close(() => resolve()));
});

/** 完整走一遍 authorize → callback（携带 state cookie） */
async function runLoginFlow(next: string): Promise<{ status: number; location: string | null; stateCookie: string }> {
  const authorize = await http(api.baseUrl, 'GET', `/v1/oauth/github/authorize?next=${encodeURIComponent(next)}`);
  expect(authorize.status).toBe(302);
  const location = authorize.headers.get('location')!;
  expect(location.startsWith(`${githubUrl}/login/oauth/authorize?`)).toBe(true);
  const state = new URL(location).searchParams.get('state')!;
  const stateCookie = authorize.headers
    .getSetCookie()
    .find((c) => c.startsWith('ag_oauth_state='))!
    .split(';')[0]!
    .split('=')[1]!;
  const callback = await http(api.baseUrl, 'GET', `/v1/oauth/github/callback?code=mock-code&state=${state}`, {
    cookie: `ag_oauth_state=${stateCookie}`,
  });
  return { status: callback.status, location: callback.headers.get('location'), stateCookie };
}

describe('E2E ③ OAuth 全链（mock GitHub）', () => {
  it('providers 端点只列已配置项；Google 未配置 404', async () => {
    const providers = await http(api.baseUrl, 'GET', '/v1/oauth/providers');
    expect(providers.body).toEqual({ providers: ['github'] });
    const google = await http(api.baseUrl, 'GET', '/v1/oauth/google/authorize');
    expect(google.status).toBe(404);
    expect(errCode(google)).toBe('oauth_not_configured');
  });

  it('全链：authorize 302 → mock GitHub → callback 302 前端 #token= → /v1/me 200', async () => {
    const flow = await runLoginFlow('/billing?tab=usage');
    expect(flow.status).toBe(302);
    expect(flow.location!.startsWith('https://console.e2e.test/billing?tab=usage#token=')).toBe(true);

    const token = decodeURIComponent(flow.location!.split('#token=')[1]!);
    const me = await http(api.baseUrl, 'GET', '/v1/me', { token });
    expect(me.status).toBe(200);
    const meBody = me.body as { email: string | null; displayName: string | null };
    expect(meBody.email).toBe('e2e-octo@mock.gh'); // GitHub 主邮箱（primary+verified）
    expect(meBody.displayName).toBe('e2e-octocat'); // name 空 → login
    // 登记进清理台账
    fx.userIds.push((me.body as { id: number }).id);
  });

  it('二次登录同 subject：不重复建号，重定向仍可登录', async () => {
    const first = await runLoginFlow('/');
    const second = await runLoginFlow('/');
    expect(first.status).toBe(302);
    expect(second.status).toBe(302);
    // 同一 GitHub subject → 同一账号（424242）
    const t1 = decodeURIComponent(first.location!.split('#token=')[1]!);
    const t2 = decodeURIComponent(second.location!.split('#token=')[1]!);
    const me1 = await http(api.baseUrl, 'GET', '/v1/me', { token: t1 });
    const me2 = await http(api.baseUrl, 'GET', '/v1/me', { token: t2 });
    expect((me1.body as { id: number }).id).toBe((me2.body as { id: number }).id);
  });

  it('攻击面：state 不匹配 403 / 重放同 state 410（单次消费）', async () => {
    const authorize = await http(api.baseUrl, 'GET', '/v1/oauth/github/authorize');
    const location = authorize.headers.get('location')!;
    const state = new URL(location).searchParams.get('state')!;

    const mismatch = await http(api.baseUrl, 'GET', `/v1/oauth/github/callback?code=c&state=${state}`, {
      cookie: 'ag_oauth_state=deadbeef',
    });
    expect(mismatch.status).toBe(403);
    expect(errCode(mismatch)).toBe('oauth_state_mismatch');

    // 正确消费一次 → 同 state 重放 410（单次）
    const ok = await http(api.baseUrl, 'GET', `/v1/oauth/github/callback?code=c&state=${state}`, {
      cookie: `ag_oauth_state=${state}`,
    });
    expect(ok.status).toBe(302);
    const okToken = decodeURIComponent(ok.headers.get('location')!.split('#token=')[1]!);
    const meRes = await http(api.baseUrl, 'GET', '/v1/me', { token: okToken });
    fx.userIds.push((meRes.body as { id: number }).id);
    const replay = await http(api.baseUrl, 'GET', `/v1/oauth/github/callback?code=c&state=${state}`, {
      cookie: `ag_oauth_state=${state}`,
    });
    expect(replay.status).toBe(410);
    expect(errCode(replay)).toBe('oauth_state_expired');
  });

  it('封禁 OAuth 账号：登录即 403 account_unavailable', async () => {
    const flow = await runLoginFlow('/');
    expect(flow.status).toBe(302);
    const token = decodeURIComponent(flow.location!.split('#token=')[1]!);
    const me = await http(api.baseUrl, 'GET', '/v1/me', { token });
    const userId = (me.body as { id: number }).id;
    fx.userIds.push(userId);
    await api.db.update(users).set({ status: 1 }).where(eq(users.id, userId));
    const authorize = await http(api.baseUrl, 'GET', '/v1/oauth/github/authorize');
    const state = new URL(authorize.headers.get('location')!).searchParams.get('state')!;
    const banned = await http(api.baseUrl, 'GET', `/v1/oauth/github/callback?code=c&state=${state}`, {
      cookie: `ag_oauth_state=${state}`,
    });
    expect(banned.status).toBe(403);
    expect(errCode(banned)).toBe('account_unavailable');
  });
});
