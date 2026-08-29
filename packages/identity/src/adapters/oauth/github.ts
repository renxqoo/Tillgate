/**
 * GitHub OAuth 上游适配器(Authorization Code 流)。
 * 上游调用全部经 oauthUpstreamFetch(单次超时+瞬态重试——境内直连 github.com
 * 间歇丢包曾把裸 fetch 拖到响应 socket 被空闲切断,反代侧 502)。
 * 邮箱策略:/user/emails 只取 primary+verified;emails 端点失败记 warn 且
 * email=null 显式返回(不阻断建号,不再静默吞错)。
 */
import type { LoggerLike } from '../../ports/logger.js';
import type { OAuthProfile, OAuthProvider } from '../../ports/oauth-provider.js';
import type { OAuthEndpointsOverride, OAuthUpstreamPolicy } from '../../domain/config.js';
import { oauthUpstreamFetch } from './upstream-fetch.js';

/** 可注入 fetch(bun 类型加宽了全局 fetch——注入面收窄为可调用视图) */
type FetchLike = (...args: Parameters<typeof fetch>) => Promise<Response>;

export interface ProviderAdapterOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly endpoints?: OAuthEndpointsOverride;
  /** 上游调用策略(超时/重试)——必填注入,装配面负责给缺省 */
  readonly upstream: OAuthUpstreamPolicy;
  readonly fetchImpl?: FetchLike;
  readonly logger: LoggerLike;
}

const GITHUB_ENDPOINTS = {
  authorizeUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  profileUrl: 'https://api.github.com/user',
  emailsUrl: 'https://api.github.com/user/emails',
} as const;

// 模块级:授权码换 access_token(Authorization Code 流标准半程)
async function exchangeGithubToken(
  deps: {
    doFetch: FetchLike;
    endpoints: { tokenUrl: string };
    opts: ProviderAdapterOptions;
  },
  input: { code: string; redirectUri: string },
): Promise<string> {
  const { doFetch, endpoints, opts } = deps;
  const tokenRes = await oauthUpstreamFetch({
    doFetch,
    url: endpoints.tokenUrl,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
        grant_type: 'authorization_code',
      }),
    },
    policy: opts.upstream,
  });
  if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status}`);
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) throw new Error('no access_token');
  return tokenJson.access_token;
}

// 模块级:/user 与 /user/emails 拉取与邮箱策略,依赖经参数注入保持工厂单一装配职责
async function githubExchangeAndProfile(
  deps: {
    doFetch: FetchLike;
    endpoints: { tokenUrl: string; profileUrl: string; emailsUrl: string };
    opts: ProviderAdapterOptions;
  },
  input: { code: string; redirectUri: string },
): Promise<OAuthProfile> {
  const { doFetch, endpoints, opts } = deps;
  const accessToken = await exchangeGithubToken(deps, input);

  const headers = {
    authorization: `Bearer ${accessToken}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'tillgate-identity',
  };
  const userRes = await oauthUpstreamFetch({
    doFetch,
    url: endpoints.profileUrl,
    init: { headers },
    policy: opts.upstream,
  });
  if (!userRes.ok) throw new Error(`github profile failed: ${userRes.status}`);
  const user = (await userRes.json()) as { id: number; login: string; name: string | null };
  let email: string | null = null;
  // emails 是 best-effort 降级面(失败仅丢邮箱不阻断登录)——单次尝试不重试,
  // 避免为非关键数据把登录拖慢一个重试周期
  const emailsRes = await oauthUpstreamFetch({
    doFetch,
    url: endpoints.emailsUrl,
    init: { headers },
    policy: { ...opts.upstream, attempts: 1 },
  });
  if (emailsRes.ok) {
    const emails = (await emailsRes.json()) as Array<{
      email: string;
      primary: boolean;
      verified: boolean;
    }>;
    email = emails.find((e) => e.primary && e.verified)?.email ?? null;
  } else {
    // 上游邮箱端点故障不再静默——记 warn,email 显式为 null(不阻断建号)
    opts.logger.warn(
      { status: emailsRes.status },
      'github emails endpoint failed; profile continues without email',
    );
  }
  return { subject: String(user.id), email, displayName: user.name ?? user.login };
}

export function createGithubProvider(opts: ProviderAdapterOptions): OAuthProvider {
  const doFetch = opts.fetchImpl ?? fetch;
  const endpoints = { ...GITHUB_ENDPOINTS, ...opts.endpoints };
  return {
    authorizeUrl({ redirectUri, state }) {
      const url = new URL(endpoints.authorizeUrl);
      url.searchParams.set('client_id', opts.clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('scope', 'read:user user:email');
      url.searchParams.set('state', state);
      return url.toString();
    },

    async exchangeAndProfile({ code, redirectUri }): Promise<OAuthProfile> {
      return githubExchangeAndProfile({ doFetch, endpoints, opts }, { code, redirectUri });
    },
  };
}
