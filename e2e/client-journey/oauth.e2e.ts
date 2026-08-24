/**
 * OAuth 社交登录 E2E（老仓 e2e-oauth 迁移；本地 mock GitHub 上游）：
 * providers 目录 → authorize 302（state cookie 双提交 + 端点参数）→ callback
 * find-or-create 建号 + #token= fragment 回传 → token 可用 → state 单次消费
 * （重放 410）/ cookie 不符 403 / 未配置 provider 404 / 未知 provider 404。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  apiClient,
  bootHarness,
  cleanupUsers,
  infraReady,
  rawGet,
  reservePort,
  startMockGithub,
  type E2eHarness,
} from './harness.js';

const context = describe.skipIf(!(await infraReady()));

let h: E2eHarness;
let api: ReturnType<typeof apiClient>;
const oauthEmail = `e2e-oauth-${Date.now().toString(36)}@example.com`;
let oauthUserId = 0;

beforeAll(async () => {
  const github = await startMockGithub();
  github.profile.email = oauthEmail;
  const port = await reservePort();
  h = await bootHarness({ appPort: port, github });
  api = apiClient(h.baseUrl);
});

afterAll(async () => {
  if (oauthUserId !== 0) {
    await cleanupUsers(h.assembly.db, [{ id: oauthUserId, email: oauthEmail }]);
  }
  if (h.github != null) await new Promise<void>((r) => h.github!.server.close(() => r()));
  await h.teardown();
});

context('OAuth 社交登录（mock GitHub 上游全链）', () => {
  it('authorize → callback → token 回传 → 单次消费与攻击面', async () => {
    // providers 目录：只列已配置的（google 未配）
    const providers = (await (await api('/v1/oauth/providers')).json()) as {
      providers: string[];
    };
    expect(providers.providers).toEqual(['github']);

    // 未配置 provider（google 无凭证 → 不在已配置目录）→ 404 client.oauth_unknown
    // （identity 的 oauth_provider_unconfigured 属词表内无凭证路径——本 app 目录即凭证派生，不可达）
    const google = await api('/v1/oauth/google/authorize');
    expect(google.status).toBe(404);
    expect(((await google.json()) as { error: { code: string } }).error.code).toBe(
      'client.oauth_unknown',
    );

    // 未知 provider → 404 client.oauth_unknown
    const unknown = await api('/v1/oauth/gitlab/authorize');
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe(
      'client.oauth_unknown',
    );

    // authorize：302 指向 mock 上游，参数齐（client_id/redirect_uri/state）
    const authorize = await rawGet(`${h.baseUrl}/v1/oauth/github/authorize?next=/billing`);
    expect(authorize.status).toBe(302);
    const location = String(authorize.headers.location ?? '');
    const authUrl = new URL(location);
    expect(`${authUrl.origin}${authUrl.pathname}`).toBe(`${h.github?.baseUrl}/authorize`);
    expect(authUrl.searchParams.get('client_id')).toBe('e2e-client-id');
    expect(authUrl.searchParams.get('redirect_uri')).toBe(`${h.baseUrl}/v1/oauth/github/callback`);
    const state = authUrl.searchParams.get('state') ?? '';
    expect(state).toMatch(/^[0-9a-f]{48}$/);
    const setCookieHeader = authorize.headers['set-cookie'];
    const setCookie = Array.isArray(setCookieHeader)
      ? setCookieHeader.find((c) => c.startsWith('tl_oauth_state='))
      : setCookieHeader;
    const cookieState = setCookie?.match(/tl_oauth_state=([^;]+)/)?.[1] ?? null;
    expect(cookieState).toBe(state);

    // callback：cookie↔query 双提交一致 → code 换 profile（mock 上游）→ 建号 + fragment 回传
    const callback = await rawGet(
      `${h.baseUrl}/v1/oauth/github/callback?code=mock-code&state=${state}`,
      {
        cookie: `tl_oauth_state=${state}`,
      },
    );
    expect(callback.status).toBe(302);
    const redirect = String(callback.headers.location ?? '');
    expect(redirect).toContain(`${h.baseUrl}/app/billing#token=`);
    const fragmentToken = decodeURIComponent(redirect.split('#token=')[1] ?? '');
    expect(fragmentToken.length).toBeGreaterThan(0);
    // mock 上游确实被调（token + profile + emails）
    const paths = (h.github?.requests ?? []).map((r) => r.path);
    expect(paths).toContain('/token');
    expect(paths).toContain('/user');
    expect(paths).toContain('/user/emails');

    // fragment token 是可用会话：/v1/me 返回 mock 邮箱建号的用户
    const me = (await (await api('/v1/me', { token: fragmentToken })).json()) as {
      id: number;
      email: string | null;
    };
    expect(me.email).toBe(oauthEmail);
    oauthUserId = me.id;

    // state 单次消费：重放（cookie 重设同值）→ 410
    const replay = await api(`/v1/oauth/github/callback?code=mock-code&state=${state}`, {
      headers: { cookie: `tl_oauth_state=${state}` },
    });
    expect(replay.status).toBe(410);

    // 上游换码故障 → identity.oauth_profile_failed → 502（FaceOverride 钉死）
    const failAuthorize = await rawGet(`${h.baseUrl}/v1/oauth/github/authorize`);
    const failUrl = new URL(String(failAuthorize.headers.location ?? ''));
    const failState = failUrl.searchParams.get('state') ?? '';
    const failCallback = await rawGet(
      `${h.baseUrl}/v1/oauth/github/callback?code=fail-code&state=${failState}`,
      { cookie: `tl_oauth_state=${failState}` },
    );
    expect(failCallback.status).toBe(502);
    expect(JSON.parse(failCallback.body).error.code).toBe('identity.oauth_profile_failed');

    // cookie 不符（双提交破坏）→ 403
    const mismatch = await api(`/v1/oauth/github/callback?code=c&state=${state}`, {
      headers: { cookie: 'tl_oauth_state=evil' },
    });
    expect(mismatch.status).toBe(403);

    // 已绑定用户二次登录：同 subject 直用既有账号（不重建）
    const again = await rawGet(`${h.baseUrl}/v1/oauth/github/authorize`);
    const againUrl = new URL(String(again.headers.location ?? ''));
    const state2 = againUrl.searchParams.get('state') ?? '';
    const callback2 = await rawGet(
      `${h.baseUrl}/v1/oauth/github/callback?code=mock-code-2&state=${state2}`,
      { cookie: `tl_oauth_state=${state2}` },
    );
    expect(callback2.status).toBe(302);
    const token2 = decodeURIComponent(
      String(callback2.headers.location ?? '').split('#token=')[1] ?? '',
    );
    const me2 = (await (await api('/v1/me', { token: token2 })).json()) as { id: number };
    expect(me2.id).toBe(oauthUserId);
  }, 120_000);
});
