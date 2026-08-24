/**
 * Google OAuth 上游适配器(Authorization Code 流)。
 * 邮箱策略:userinfo 仅取 email_verified=true 的邮箱;displayName 缺省取邮箱本地部分。
 */
import type { OAuthProvider, OAuthProfile } from '../../ports/oauth-provider.js';
import type { ProviderAdapterOptions } from './github.js';

const GOOGLE_ENDPOINTS = {
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  profileUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
} as const;

// 模块级:token 交换 + userinfo 拉取与邮箱策略,依赖经参数注入保持工厂单一装配职责
async function googleExchangeAndProfile(
  deps: {
    doFetch: typeof fetch;
    endpoints: { tokenUrl: string; profileUrl: string };
    opts: ProviderAdapterOptions;
  },
  input: { code: string; redirectUri: string },
): Promise<OAuthProfile> {
  const { doFetch, endpoints, opts } = deps;
  const tokenRes = await doFetch(endpoints.tokenUrl, {
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
  });
  if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status}`);
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) throw new Error('no access_token');

  const res = await doFetch(endpoints.profileUrl, {
    headers: { authorization: `Bearer ${tokenJson.access_token}` },
  });
  if (!res.ok) throw new Error(`google profile failed: ${res.status}`);
  const profile = (await res.json()) as {
    sub: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
  };
  return {
    subject: profile.sub,
    email: profile.email_verified && profile.email ? profile.email : null,
    // split('@') 对非空串必返回至少一段,[0] 运行时恒存在,?? null 仅收窄类型
    displayName: profile.name ?? (profile.email ? (profile.email.split('@')[0] ?? null) : null),
  };
}

export function createGoogleProvider(opts: ProviderAdapterOptions): OAuthProvider {
  const doFetch = opts.fetchImpl ?? fetch;
  const endpoints = { ...GOOGLE_ENDPOINTS, ...opts.endpoints };
  return {
    authorizeUrl({ redirectUri, state }) {
      const url = new URL(endpoints.authorizeUrl);
      url.searchParams.set('client_id', opts.clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('scope', 'openid email profile');
      url.searchParams.set('state', state);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('access_type', 'online');
      return url.toString();
    },

    async exchangeAndProfile({ code, redirectUri }): Promise<OAuthProfile> {
      return googleExchangeAndProfile({ doFetch, endpoints, opts }, { code, redirectUri });
    },
  };
}
