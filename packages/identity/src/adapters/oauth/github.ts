/**
 * GitHub OAuth 上游适配器(Authorization Code 流)。
 * 邮箱策略:/user/emails 只取 primary+verified;emails 端点失败记 warn 且
 * email=null 显式返回(不阻断建号,v1 语义 + B27 修复:不再静默吞错)。
 */
import type { LoggerLike } from '../../ports/logger.js';
import type { OAuthProfile, OAuthProvider } from '../../ports/oauth-provider.js';
import type { OAuthEndpointsOverride } from '../../domain/config.js';

export interface ProviderAdapterOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly endpoints?: OAuthEndpointsOverride;
  readonly fetchImpl?: typeof fetch;
  readonly logger: LoggerLike;
}

const GITHUB_ENDPOINTS = {
  authorizeUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  profileUrl: 'https://api.github.com/user',
  emailsUrl: 'https://api.github.com/user/emails',
} as const;

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
      const tokenRes = await doFetch(endpoints.tokenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          client_id: opts.clientId,
          client_secret: opts.clientSecret,
          code,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status}`);
      const tokenJson = (await tokenRes.json()) as { access_token?: string };
      if (!tokenJson.access_token) throw new Error('no access_token');

      const headers = {
        authorization: `Bearer ${tokenJson.access_token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'tokenlens-identity',
      };
      const userRes = await doFetch(endpoints.profileUrl, { headers });
      if (!userRes.ok) throw new Error(`github profile failed: ${userRes.status}`);
      const user = (await userRes.json()) as { id: number; login: string; name: string | null };
      let email: string | null = null;
      const emailsRes = await doFetch(endpoints.emailsUrl, { headers });
      if (emailsRes.ok) {
        const emails = (await emailsRes.json()) as Array<{
          email: string;
          primary: boolean;
          verified: boolean;
        }>;
        email = emails.find((e) => e.primary && e.verified)?.email ?? null;
      } else {
        // B27:上游邮箱端点故障不再静默——记 warn,email 显式为 null(不阻断建号)
        opts.logger.warn(
          { status: emailsRes.status },
          'github emails endpoint failed; profile continues without email',
        );
      }
      return { subject: String(user.id), email, displayName: user.name ?? user.login };
    },
  };
}
