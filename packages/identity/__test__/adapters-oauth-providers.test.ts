/**
 * OAuth provider 适配器测试(注入 fetch):授权 URL 形状、code 交换请求形状、
 * profile 映射(GitHub primary+verified 过滤 / Google email_verified)、
 * B27 回归(GitHub emails 端点失败 warn + email=null 不阻断)。
 */
import { describe, expect, it, vi } from 'vitest';
import { createGithubProvider } from '../src/adapters/oauth/github.js';
import { createGoogleProvider } from '../src/adapters/oauth/google.js';

const logger = { warn: vi.fn() };
const base = { clientId: 'cid', clientSecret: 'csecret', logger };

describe('github 适配器', () => {
  it('authorizeUrl:scope/redirect_uri/state', () => {
    const url = createGithubProvider(base).authorizeUrl({
      redirectUri: 'https://api.example.com/cb',
      state: 'st-1',
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(parsed.searchParams.get('client_id')).toBe('cid');
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://api.example.com/cb');
    expect(parsed.searchParams.get('scope')).toBe('read:user user:email');
    expect(parsed.searchParams.get('state')).toBe('st-1');
  });

  it('exchangeAndProfile:user + emails(primary&verified 过滤)', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('access_token')) {
        expect(String(init?.body)).toContain('grant_type=authorization_code');
        expect(String(init?.body)).toContain('redirect_uri=https%3A%2F%2Fapi.example.com%2Fcb');
        return Response.json({ access_token: 'at-1' });
      }
      if (target.includes('/user/emails')) {
        return Response.json([
          { email: 'private@gh.example.com', primary: false, verified: true },
          { email: 'main@gh.example.com', primary: true, verified: true },
          { email: 'unverified@gh.example.com', primary: true, verified: false },
        ]);
      }
      return Response.json({ id: 42, login: 'octocat', name: 'Octo Cat' });
    }) as unknown as typeof fetch;
    const profile = await createGithubProvider({ ...base, fetchImpl }).exchangeAndProfile({
      code: 'c',
      redirectUri: 'https://api.example.com/cb',
    });
    expect(profile).toEqual({
      subject: '42',
      email: 'main@gh.example.com',
      displayName: 'Octo Cat',
    });
  });

  it('B27 回归:emails 端点失败 → warn + email=null,不阻断;name 缺省 login', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes('access_token')) return Response.json({ access_token: 'at' });
      if (target.includes('/user/emails')) return new Response('boom', { status: 503 });
      return Response.json({ id: 7, login: 'octo', name: null });
    }) as unknown as typeof fetch;
    const profile = await createGithubProvider({ ...base, fetchImpl, logger }).exchangeAndProfile({
      code: 'c',
      redirectUri: 'https://cb',
    });
    expect(profile).toEqual({ subject: '7', email: null, displayName: 'octo' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('token 交换失败/无 access_token/profile 失败 → 抛错(用例翻译 oauth_profile_failed)', async () => {
    const failing = createGithubProvider({
      ...base,
      fetchImpl: vi.fn(
        async () => new Response('nope', { status: 500 }),
      ) as unknown as typeof fetch,
    });
    await expect(
      failing.exchangeAndProfile({ code: 'c', redirectUri: 'https://cb' }),
    ).rejects.toThrow(/token exchange failed/);
    const noToken = createGithubProvider({
      ...base,
      fetchImpl: vi.fn(async () => Response.json({})) as unknown as typeof fetch,
    });
    await expect(
      noToken.exchangeAndProfile({ code: 'c', redirectUri: 'https://cb' }),
    ).rejects.toThrow(/no access_token/);
  });
});

describe('google 适配器', () => {
  it('authorizeUrl:response_type/access_type/scope', () => {
    const url = createGoogleProvider(base).authorizeUrl({ redirectUri: 'https://cb', state: 'st' });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(parsed.searchParams.get('scope')).toBe('openid email profile');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('access_type')).toBe('online');
  });

  it('profile:email_verified 才收;displayName 缺省邮箱本地部分', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('token')) return Response.json({ access_token: 'at' });
      return Response.json({ sub: 'g-sub-1', email: 'g@example.com', email_verified: true });
    }) as unknown as typeof fetch;
    const profile = await createGoogleProvider({ ...base, fetchImpl }).exchangeAndProfile({
      code: 'c',
      redirectUri: 'https://cb',
    });
    expect(profile).toEqual({ subject: 'g-sub-1', email: 'g@example.com', displayName: 'g' });

    const unverified = createGoogleProvider({
      ...base,
      fetchImpl: vi.fn(async (url: string | URL | Request) => {
        if (String(url).includes('token')) return Response.json({ access_token: 'at' });
        return Response.json({
          sub: 's',
          email: 'g@example.com',
          email_verified: false,
          name: 'G',
        });
      }) as unknown as typeof fetch,
    });
    await expect(
      unverified.exchangeAndProfile({ code: 'c', redirectUri: 'https://cb' }),
    ).resolves.toMatchObject({ email: null, displayName: 'G' });
  });

  it('端点覆盖(私有化/测试)', async () => {
    const url = createGoogleProvider({
      ...base,
      endpoints: { authorizeUrl: 'https://idp.internal/auth' },
    }).authorizeUrl({ redirectUri: 'https://cb', state: 's' });
    expect(url.startsWith('https://idp.internal/auth?')).toBe(true);
  });
});
