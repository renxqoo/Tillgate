import { and, eq } from 'drizzle-orm';
import { users } from '@ai-gateway/db/schema';
import { pgSqlState } from '@ai-gateway/http';
import type { ClientServices } from './index.js';
import type { ClientApiConfig, OAuthCredentials } from '../config.js';
import { defaultDisplayName, issueSession } from './auth.js';

/**
 * OAuth 社交登录（GitHub / Google，Authorization Code 流，服务端机密客户端）。
 *
 * 身份模型（与本地账号同一张 users 表，物理隔离）：
 *   issuer = 'github' | 'google'（登录域），subject = 平台用户 id（string）
 *   唯一键 users_issuer_subject_uq 兜底并发；email 仅展示（可空），
 *   不与本地邮箱账号自动合并（issuer 不同 = 不同账号，防劫持）。
 *
 * 防护：state 双提交（cookie + Redis 单次）防 login-CSRF / 授权码一次性；
 * next 仅站内相对路径防 open redirect。邮箱已由平台验证 → 无需再发码。
 */

export type OAuthProviderName = 'github' | 'google';

export interface ProviderEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  profileUrl: string;
  /** GitHub 专用：主邮箱端点 */
  emailsUrl?: string;
}

export const GITHUB_ENDPOINTS: ProviderEndpoints = {
  authorizeUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  profileUrl: 'https://api.github.com/user',
  emailsUrl: 'https://api.github.com/user/emails',
};

export const GOOGLE_ENDPOINTS: ProviderEndpoints = {
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  profileUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
};

export interface OAuthProfile {
  /** 平台用户 id（存 subject） */
  subject: string;
  email: string | null;
  displayName: string | null;
}

/** 配置了凭证的 provider 才可用（前端据此显隐按钮） */
export function oauthProviderCreds(
  config: ClientApiConfig,
  provider: OAuthProviderName,
): OAuthCredentials | null {
  return provider === 'github' ? config.oauth.github : config.oauth.google;
}

/** 授权跳转 URL（含 state；GitHub 要 read:user 之外的 user:email 才能拿主邮箱） */
export function buildAuthorizeUrl(
  config: ClientApiConfig,
  provider: OAuthProviderName,
  state: string,
): string {
  const creds = oauthProviderCreds(config, provider)!;
  const endpoints =
    provider === 'github'
      ? config.oauth.endpoints?.github ?? GITHUB_ENDPOINTS
      : config.oauth.endpoints?.google ?? GOOGLE_ENDPOINTS;
  const redirectUri = `${config.oauth.apiBase}/api/auth/oauth/${provider}/callback`;
  const scope = provider === 'github' ? 'read:user user:email' : 'openid email profile';
  const url = new URL(endpoints.authorizeUrl);
  url.searchParams.set('client_id', creds.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', state);
  if (provider === 'google') {
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('access_type', 'online');
  }
  return url.toString();
}

/** 授权码 → 访问令牌（form 编码，两平台通用格式） */
async function exchangeCode(
  config: ClientApiConfig,
  provider: OAuthProviderName,
  code: string,
): Promise<string> {
  const creds = oauthProviderCreds(config, provider)!;
  const endpoints =
    provider === 'github'
      ? config.oauth.endpoints?.github ?? GITHUB_ENDPOINTS
      : config.oauth.endpoints?.google ?? GOOGLE_ENDPOINTS;
  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    code,
    redirect_uri: `${config.oauth.apiBase}/api/auth/oauth/${provider}/callback`,
    grant_type: 'authorization_code',
  });
  const res = await fetch(endpoints.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  });
  if (!res.ok) throw new Error(`oauth token exchange failed: ${res.status}`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('oauth token exchange returned no access_token');
  return json.access_token;
}

/** 平台 profile → 归一身份（email 已由平台验证；GitHub 主邮箱需二次请求） */
export async function fetchOAuthProfile(
  config: ClientApiConfig,
  provider: OAuthProviderName,
  code: string,
): Promise<OAuthProfile> {
  const accessToken = await exchangeCode(config, provider, code);
  const endpoints =
    provider === 'github'
      ? config.oauth.endpoints?.github ?? GITHUB_ENDPOINTS
      : config.oauth.endpoints?.google ?? GOOGLE_ENDPOINTS;

  if (provider === 'github') {
    const ghEndpoints = { ...GITHUB_ENDPOINTS, ...config.oauth.endpoints?.github };
    const headers = {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'ai-gateway-client-api',
    };
    const userRes = await fetch(ghEndpoints.profileUrl, { headers });
    if (!userRes.ok) throw new Error(`github profile failed: ${userRes.status}`);
    const user = (await userRes.json()) as { id: number; login: string; name: string | null };
    let email: string | null = null;
    if (ghEndpoints.emailsUrl) {
      const emailsRes = await fetch(ghEndpoints.emailsUrl, { headers });
      if (emailsRes.ok) {
        const emails = (await emailsRes.json()) as Array<{
          email: string;
          primary: boolean;
          verified: boolean;
        }>;
        email = emails.find((e) => e.primary && e.verified)?.email ?? null;
      }
    }
    // 平台用户名优先级：真实姓名 → login（GitHub 用户名）；都不给才走 rx 默认名
    return { subject: String(user.id), email, displayName: user.name ?? user.login };
  }

  const res = await fetch(endpoints.profileUrl, {
    headers: { authorization: `Bearer ${accessToken}` },
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
    // Google 无独立用户名：姓名 → 邮箱前缀；都不给才走 rx 默认名
    displayName: profile.name ?? (profile.email ? profile.email.split('@')[0]! : null),
  };
}

export type OAuthLoginOutcome =
  | { kind: 'success'; token: string; userId: number; email: string | null; gifted: boolean; created: boolean }
  | { kind: 'account_unavailable' };

/** find-or-create（issuer=provider, subject=平台 id）+ 签发会话（赠额幂等） */
export async function loginWithOAuth(
  s: ClientServices,
  config: ClientApiConfig,
  provider: OAuthProviderName,
  profile: OAuthProfile,
): Promise<OAuthLoginOutcome> {
  let created = false;
  let rows = await s.db
    .select({ id: users.id, email: users.email, status: users.status })
    .from(users)
    .where(and(eq(users.issuer, provider), eq(users.subject, profile.subject)))
    .limit(1);
  let user = rows[0];

  if (!user) {
    try {
      const [inserted] = await s.db
        .insert(users)
        .values({
          issuer: provider,
          subject: profile.subject,
          identityProvider: provider,
          email: profile.email,
          displayName: profile.displayName ?? defaultDisplayName(),
        })
        .returning({ id: users.id, email: users.email, status: users.status });
      user = inserted!;
      created = true;
    } catch (e) {
      // 并发同号登录：唯一键兜底 → 回查
      if (e instanceof Error && pgSqlState(e) === '23505') {
        rows = await s.db
          .select({ id: users.id, email: users.email, status: users.status })
          .from(users)
          .where(and(eq(users.issuer, provider), eq(users.subject, profile.subject)))
          .limit(1);
        user = rows[0];
      } else {
        throw e;
      }
    }
  }
  if (!user || user.status !== 0) return { kind: 'account_unavailable' };

  const session = await issueSession(s, config, user.id);
  return {
    kind: 'success',
    token: session.token,
    userId: user.id,
    email: user.email ?? profile.email,
    gifted: session.gifted,
    created,
  };
}
