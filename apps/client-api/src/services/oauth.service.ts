/**
 * OAuth 社交登录（GitHub/Google，Authorization Code 流，服务端机密客户端）。
 *
 * 身份模型（与本地账号同表，物理隔离）：issuer = 'github'|'google'，subject = 平台 id；
 * 唯一键 users_issuer_subject_uq 兜底并发；email 仅展示，不与本地邮箱账号自动合并
 * （issuer 不同 = 不同账号，防劫持）。邮箱已由平台验证 → 无需再发码。
 *
 * v2 会话形态差异：Bearer 无 Cookie 会话——回调把会话 token 放 URL fragment
 * （#token=…，不经服务端日志/Referer 泄漏）重定向前端；state 双提交（cookie + 可选
 * Redis 单次记录）防 login-CSRF；next 仅站内相对路径防 open redirect。
 */
import { randomBytes } from 'node:crypto';
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type Repositories } from '@ai-gateway/repository';
import type { Redis } from 'ioredis';
import { signSession } from '@ai-gateway/identity';
import type { RunContext, WalletApi } from '@ai-gateway/service';
import { AppError } from '../http/error-map.js';

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

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  /** 端点覆盖（部分覆盖即可，未覆盖项用公网缺省；测试/私有化网关） */
  endpoints?: Partial<ProviderEndpoints>;
}

export interface OAuthProfile {
  subject: string;
  email: string | null;
  displayName: string | null;
}

/** state 单次存储端口（Redis 形态；null = 仅 cookie 双提交 + HMAC 完整性） */
export interface OAuthStateStore {
  save(state: string, payload: { provider: OAuthProviderName; next: string }, ttlS: number): Promise<void>;
  /** 取出并删除（单次）；不存在返回 null */
  consume(state: string): Promise<{ provider: OAuthProviderName; next: string } | null>;
}

export function createRedisStateStore(redis: Redis): OAuthStateStore {
  return {
    async save(state, payload, ttlS) {
      await redis.set(`oauth:state:${state}`, JSON.stringify(payload), 'EX', ttlS);
    },
    async consume(state) {
      const raw = await redis.getdel(`oauth:state:${state}`);
      return raw ? (JSON.parse(raw) as { provider: OAuthProviderName; next: string }) : null;
    },
  };
}

export interface OAuthServiceDeps {
  db: Db;
  repos?: Repositories;
  wallet: WalletApi;
  jwtSecret: string;
  sessionTtlSeconds: number;
  /** 前端基地址（回调重定向目标） */
  frontendUrl: string;
  /** 本服务对外基地址（拼 redirect_uri） */
  apiBase: string;
  providers: Partial<Record<OAuthProviderName, OAuthProviderConfig>>;
  /** state 单次存储（Redis——多副本共享 + 重启不丢；内存实现已按「Redis 必配」决策删除） */
  stateStore: OAuthStateStore;
  /** 注册赠送（OAuth 建号与本地注册同待遇；'0' = 关闭） */
  giftAmount: string;
  /** fetch 注入（测试替身；缺省全局 fetch） */
  fetchImpl?: typeof fetch;
  clock?: () => Date;
}

export const OAUTH_STATE_TTL_S = 600;

/** next 只接受站内相对路径（防 open redirect） */
export function safeNext(raw: string | undefined): string {
  if (raw && raw.startsWith('/') && !raw.startsWith('//')) return raw;
  return '/dashboard';
}

export interface OAuthService {
  /** 已配置的登录方式（前端按钮显隐） */
  providers(): OAuthProviderName[];
  /** 授权跳转 URL + state（路由层负责 state cookie 双提交） */
  authorize(provider: OAuthProviderName, next: string): Promise<{ url: string; state: string }>;
  /** 回调：state 校验（cookie 双提交 + store 单次 + provider 匹配）→ 换码 → find-or-create → 会话 */
  callback(
    ctx: RunContext,
    input: {
      provider: OAuthProviderName;
      code: string;
      state: string;
      cookieState: string | undefined;
    },
  ): Promise<{ redirectUrl: string; userId: number; created: boolean }>;
}

export function createOAuthService(deps: OAuthServiceDeps): OAuthService {
  const { db, wallet } = deps;
  const repos = deps.repos ?? createRepositories();
  const fetchImpl = deps.fetchImpl ?? fetch;

  const creds = (provider: OAuthProviderName): (OAuthProviderConfig & { endpoints: ProviderEndpoints }) | null => {
    const conf = deps.providers[provider];
    if (!conf) return null;
    const base = provider === 'github' ? GITHUB_ENDPOINTS : GOOGLE_ENDPOINTS;
    return { ...conf, endpoints: { ...base, ...conf.endpoints } };
  };

  const requireCreds = (provider: OAuthProviderName) => {
    const conf = creds(provider);
    if (!conf) {
      throw new AppError(404, 'oauth_not_configured', '该登录方式未配置，请联系管理员');
    }
    return conf;
  };

  const redirectUri = (provider: OAuthProviderName) =>
    `${deps.apiBase.replace(/\/$/, '')}/v1/oauth/${provider}/callback`;

  /** 业务结果（AppError）直传；网络/上游失败统一 502（吞掉会把业务拒绝伪装成故障） */
  async function fetchProfile(provider: OAuthProviderName, code: string): Promise<OAuthProfile> {
    const conf = requireCreds(provider);
    try {
      const body = new URLSearchParams({
        client_id: conf.clientId,
        client_secret: conf.clientSecret,
        code,
        redirect_uri: redirectUri(provider),
        grant_type: 'authorization_code',
      });
      const tokenRes = await fetchImpl(conf.endpoints.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body,
      });
      if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status}`);
      const tokenJson = (await tokenRes.json()) as { access_token?: string };
      if (!tokenJson.access_token) throw new Error('no access_token');

      if (provider === 'github') {
        const headers = {
          authorization: `Bearer ${tokenJson.access_token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'ai-gateway-client-api',
        };
        const userRes = await fetchImpl(conf.endpoints.profileUrl, { headers });
        if (!userRes.ok) throw new Error(`github profile failed: ${userRes.status}`);
        const user = (await userRes.json()) as { id: number; login: string; name: string | null };
        let email: string | null = null;
        if (conf.endpoints.emailsUrl) {
          const emailsRes = await fetchImpl(conf.endpoints.emailsUrl, { headers });
          if (emailsRes.ok) {
            const emails = (await emailsRes.json()) as Array<{
              email: string;
              primary: boolean;
              verified: boolean;
            }>;
            email = emails.find((e) => e.primary && e.verified)?.email ?? null;
          }
        }
        return { subject: String(user.id), email, displayName: user.name ?? user.login };
      }

      const res = await fetchImpl(conf.endpoints.profileUrl, {
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
        displayName: profile.name ?? (profile.email ? profile.email.split('@')[0]! : null),
      };
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(502, 'oauth_exchange_failed', '第三方登录交换失败，请重试');
    }
  }

  return {
    providers() {
      return (['github', 'google'] as const).filter((p) => creds(p) !== null);
    },

    async authorize(provider, next) {
      const conf = requireCreds(provider);
      const state = randomBytes(24).toString('hex');
      try {
        await deps.stateStore.save(state, { provider, next: safeNext(next) }, OAUTH_STATE_TTL_S);
      } catch {
        // Redis 不可达：不发授权跳转（fail-closed——带不上单次 state 的跳转必坏）
        throw new AppError(503, 'oauth_state_unavailable', '登录状态存储不可用，请稍后再试');
      }
      const url = new URL(conf.endpoints.authorizeUrl);
      url.searchParams.set('client_id', conf.clientId);
      url.searchParams.set('redirect_uri', redirectUri(provider));
      url.searchParams.set(
        'scope',
        provider === 'github' ? 'read:user user:email' : 'openid email profile',
      );
      url.searchParams.set('state', state);
      if (provider === 'google') {
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('access_type', 'online');
      }
      return { url: url.toString(), state };
    },

    async callback(ctx, input) {
      requireCreds(input.provider);

      // 双提交校验：cookie 与 query 一致（防 login-CSRF）
      if (!input.cookieState || input.cookieState !== input.state) {
        throw new AppError(403, 'oauth_state_mismatch', '登录状态校验失败，请重新发起登录');
      }
      let next = '/dashboard';
      // Redis 单次记录：state 一次性 + provider/next 绑定（不可达按已过期拒绝——fail-closed）
      const stored = await deps.stateStore
        .consume(input.state)
        .catch(() => null as Awaited<ReturnType<OAuthStateStore['consume']>>);
      if (!stored) {
        throw new AppError(410, 'oauth_state_expired', '登录状态已使用或过期，请重新发起登录');
      }
      if (stored.provider !== input.provider) {
        throw new AppError(403, 'oauth_state_mismatch', '登录方式不匹配');
      }
      next = stored.next;
      if (!input.code) throw new AppError(400, 'oauth_invalid', '缺少授权码');

      const profile = await fetchProfile(input.provider, input.code);

      // find-or-create（issuer=provider, subject=平台 id；唯一键兜底并发回查）
      let created = false;
      const lookupCtx = { db, ...ctx };
      let user = await repos.userAccount.findByOAuthSubject(lookupCtx, input.provider, profile.subject);
      if (!user) {
        try {
          user = await db.transaction(async (tx) =>
            repos.userAccount.insertOAuthUser(
              { db: tx, ...ctx },
              {
                issuer: input.provider,
                subject: profile.subject,
                email: profile.email,
                displayName: profile.displayName ?? `用户${profile.subject.slice(0, 6)}`,
              },
            ),
          );
          created = true;
        } catch (e) {
          if (e instanceof Error && (e as { code?: string }).code === '23505') {
            user = await repos.userAccount.findByOAuthSubject(lookupCtx, input.provider, profile.subject);
          } else {
            throw e;
          }
        }
      }
      if (!user || user.status !== 0) {
        throw new AppError(403, 'account_unavailable', '账号不可用');
      }

      // 建号赠送：与本地注册同 refKey 口径（幂等，可补发）
      if (created && deps.giftAmount !== '0') {
        try {
          await wallet.credit(ctx, {
            userId: user.id,
            amount: deps.giftAmount,
            refType: 'gift',
            refId: `signup:${user.id}`,
            memo: '注册赠送（OAuth）',
          });
        } catch (e) {
          console.error('[client-api] oauth gift credit failed:', e);
        }
      }

      const token = await signSession(
        { type: 'user', id: user.id, expiresInSeconds: deps.sessionTtlSeconds },
        deps.jwtSecret,
      );
      // token 走 URL fragment（不进服务端日志/Referer）；前端 JS 从 location.hash 提取
      const redirectUrl = `${deps.frontendUrl.replace(/\/$/, '')}${next}#token=${encodeURIComponent(token)}`;
      return { redirectUrl, userId: user.id, created };
    },
  };
}
