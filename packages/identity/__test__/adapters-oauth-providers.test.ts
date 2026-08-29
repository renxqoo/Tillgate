/**
 * OAuth provider 适配器测试(注入 fetch):授权 URL 形状、code 交换请求形状、
 * profile 映射(GitHub primary+verified 过滤 / Google email_verified)、
 * GitHub emails 端点失败 warn + email=null 不阻断的回归覆盖,
 * 以及上游调用策略(单次超时 + 网络错误/5xx/429 重试、4xx 不重试、emails 单次)。
 */
import { describe, expect, it, vi } from 'vitest';
import { createGithubProvider } from '../src/adapters/oauth/github.js';
import { createGoogleProvider } from '../src/adapters/oauth/google.js';

const logger = { warn: vi.fn() };
// 测试用快策略:超时用例要求挂起 fetch 在 ~百 ms 内被中止(旧实现裸 fetch
// 挂死,超时用例直接超时失败——即回归判据)
const fastUpstream = { timeoutMs: 50, attempts: 2, retryDelayMs: 5 };
const base = { clientId: 'cid', clientSecret: 'csecret', logger, upstream: fastUpstream };

// 模块级:丢包黑洞替身——永不主动 settle,只在 abort signal 触发时拒绝
// (对齐真实 fetch 语义;旧实现不传 signal,此桩永不结束 → 用例超时失败,即回归判据)
const blackholeFetch = (_url: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal != null) {
      signal.addEventListener('abort', () => {
        reject(signal.reason ?? new Error('aborted'));
      });
    }
  });

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

describe('上游调用策略(超时 + 重试——回归:境内直连 GitHub 丢包曾致 502)', () => {
  it('token 交换网络错误 → 重试后成功(总调用数 = 重试 + profile + emails)', async () => {
    let tokenCalls = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes('access_token')) {
        tokenCalls++;
        if (tokenCalls === 1) throw new TypeError('Unable to connect');
        return Response.json({ access_token: 'at-1' });
      }
      if (target.includes('/user/emails')) return Response.json([]);
      return Response.json({ id: 1, login: 'u', name: 'U' });
    }) as unknown as typeof fetch;
    const profile = await createGithubProvider({ ...base, fetchImpl }).exchangeAndProfile({
      code: 'c',
      redirectUri: 'https://cb',
    });
    expect(profile.subject).toBe('1');
    expect(fetchImpl).toHaveBeenCalledTimes(4); // token×2 + profile + emails
  });

  it('挂起 fetch 被单次超时中止并按 attempts 收口(有界失败,不再无限挂)', async () => {
    const fetchImpl = vi.fn(blackholeFetch) as unknown as typeof fetch;
    const started = Date.now();
    await expect(
      createGithubProvider({ ...base, fetchImpl }).exchangeAndProfile({
        code: 'c',
        redirectUri: 'https://cb',
      }),
    ).rejects.toThrow();
    // 2 次尝试 × 50ms 超时 + 重试间隔:远小于 1s(旧实现裸 fetch 挂 ~75s)
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('5xx 可重试:token 500 一次后成功', async () => {
    let tokenCalls = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes('access_token')) {
        tokenCalls++;
        if (tokenCalls === 1) return new Response('boom', { status: 500 });
        return Response.json({ access_token: 'at' });
      }
      if (target.includes('/user/emails')) return Response.json([]);
      return Response.json({ id: 2, login: 'u', name: null });
    }) as unknown as typeof fetch;
    const profile = await createGithubProvider({ ...base, fetchImpl }).exchangeAndProfile({
      code: 'c',
      redirectUri: 'https://cb',
    });
    expect(profile.subject).toBe('2');
  });

  it('4xx 不重试:token 400 → 单次尝试即失败', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('bad', { status: 400 }),
    ) as unknown as typeof fetch;
    await expect(
      createGithubProvider({ ...base, fetchImpl }).exchangeAndProfile({
        code: 'c',
        redirectUri: 'https://cb',
      }),
    ).rejects.toThrow(/token exchange failed: 400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('emails 端点为 best-effort 降级面:失败只尝试一次(不为非关键数据拖慢登录)', async () => {
    const freshLogger = { warn: vi.fn() };
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes('access_token')) return Response.json({ access_token: 'at' });
      if (target.includes('/user/emails')) return new Response('boom', { status: 503 });
      return Response.json({ id: 3, login: 'u', name: null });
    }) as unknown as typeof fetch;
    const profile = await createGithubProvider({
      ...base,
      fetchImpl,
      logger: freshLogger,
    }).exchangeAndProfile({ code: 'c', redirectUri: 'https://cb' });
    expect(profile).toEqual({ subject: '3', email: null, displayName: 'u' });
    expect(freshLogger.warn).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // token + profile + emails(单次)
  });
});
