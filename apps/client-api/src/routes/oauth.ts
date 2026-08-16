import { Hono } from 'hono';
import { setCookie, getCookie } from 'hono/cookie';
import { randomBytes } from 'node:crypto';

import {
  SESSION_COOKIE,
  SESSION_DEFAULT_TTL_S,
  cookieOptions,
  type ClientEnv,
} from '@ai-gateway/identity';
import { recordAudit, HttpError } from '@ai-gateway/http';

import type { ClientServices } from '../services/index.js';
import type { ClientApiConfig } from '../config.js';
import {
  buildAuthorizeUrl,
  fetchOAuthProfile,
  loginWithOAuth,
  oauthProviderCreds,
  type OAuthProviderName,
} from '../services/oauth.js';

/**
 * OAuth 社交登录端点（公开组，挂载于 /api/auth/oauth）：
 *
 *   GET /:provider/authorize?next=/path
 *     → 302 provider 授权页；state 双提交：ag_oauth_state cookie + Redis 单次记录
 *   GET /:provider/callback?code&state
 *     → cookie state == query state（防 login-CSRF）→ 换码取 profile
 *     → find-or-create → ag_session → 302 前端（next 仅站内相对路径）
 *
 * 未配置凭证的 provider → 404 OAUTH_NOT_CONFIGURED（前端按钮也隐藏）。
 */

const STATE_COOKIE = 'ag_oauth_state';
const STATE_TTL_S = 600;
const PROVIDERS: OAuthProviderName[] = ['github', 'google'];

function parseProvider(raw: string): OAuthProviderName | null {
  return PROVIDERS.includes(raw as OAuthProviderName) ? (raw as OAuthProviderName) : null;
}

/** next 只接受站内相对路径（防 open redirect），缺省 /dashboard */
function safeNext(raw: string | undefined): string {
  if (raw && raw.startsWith('/') && !raw.startsWith('//')) return raw;
  return '/dashboard';
}

export function oauthRoutes(s: ClientServices, config: ClientApiConfig): Hono<ClientEnv> {
  return new Hono<ClientEnv>()
    // 已配置的登录方式（前端据此显隐按钮；单一真相在 client-api 配置）
    .get('/providers', (c) => {
      return c.json({
        providers: PROVIDERS.filter((p) => oauthProviderCreds(config, p) !== null),
      });
    })

    .get('/:provider/authorize', async (c) => {
      const provider = parseProvider(c.req.param('provider'));
      if (!provider) throw new HttpError('OAUTH_UNKNOWN');
      if (!oauthProviderCreds(config, provider)) {
        return c.json(
          { error: { message: '该登录方式未配置，请联系管理员', code: 'OAUTH_NOT_CONFIGURED' } },
          404,
        );
      }

      const next = safeNext(c.req.query('next'));
      const state = randomBytes(24).toString('hex');
      // Redis：单次有效 + 携带 next（cookie 只做双提交比对）
      await s.redis.set(`oauth:state:${state}`, JSON.stringify({ provider, next }), 'EX', STATE_TTL_S);
      setCookie(c, STATE_COOKIE, state, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/api/auth/oauth',
        maxAge: STATE_TTL_S,
        secure: config.secureCookie,
      });
      return c.redirect(buildAuthorizeUrl(config, provider, state));
    })

    .get('/:provider/callback', async (c) => {
      const provider = parseProvider(c.req.param('provider'));
      if (!provider || !oauthProviderCreds(config, provider)) {
        return c.json(
          { error: { message: '该登录方式未配置', code: 'OAUTH_NOT_CONFIGURED' } },
          404,
        );
      }
      const code = c.req.query('code');
      const state = c.req.query('state');
      const cookieState = getCookie(c, STATE_COOKIE);
      if (!code || !state) {
        throw new HttpError('OAUTH_INVALID');
      }
      // 双提交校验：cookie 与 query 一致，且 Redis 记录存在（单次）→ 防 login-CSRF/伪造
      if (!cookieState || cookieState !== state) {
        throw new HttpError('OAUTH_STATE_MISMATCH');
      }
      const storedRaw = await s.redis.getdel(`oauth:state:${state}`);
      if (!storedRaw) {
        throw new HttpError('OAUTH_STATE_EXPIRED');
      }
      const stored = JSON.parse(storedRaw) as { provider: OAuthProviderName; next: string };
      if (stored.provider !== provider) {
        throw new HttpError('OAUTH_STATE_MISMATCH', '登录方式不匹配');
      }

      try {
        const profile = await fetchOAuthProfile(config, provider, code);
        const outcome = await loginWithOAuth(s, config, provider, profile);
        if (outcome.kind !== 'success') {
          void recordAudit(s.db, {
            actor: 'user',
            action: 'auth.oauth.unavailable',
            targetType: 'user',
            targetId: null,
            detail: { provider },
          });
          throw new HttpError('ACCOUNT_UNAVAILABLE');
        }
        void recordAudit(s.db, {
          actor: 'user',
          action: 'auth.oauth.success',
          targetType: 'user',
          targetId: outcome.userId,
          detail: { provider, created: outcome.created },
        });
        setCookie(
          c,
          SESSION_COOKIE,
          outcome.token,
          cookieOptions(config.secureCookie, SESSION_DEFAULT_TTL_S),
        );
        return c.redirect(`${config.oauth.frontendUrl}${safeNext(stored.next)}`);
      } catch (e) {
        // 业务结果（HttpError，如封禁账号 403）直接透传——502 兜底只属于
        // 真正的交换失败（网络/上游错误）；吞掉会把业务拒绝伪装成服务端故障
        // 并重复落审计
        if (e instanceof HttpError) throw e;
        void recordAudit(s.db, {
          actor: 'user',
          action: 'auth.oauth.failed',
          targetType: 'user',
          targetId: null,
          detail: { provider, err: (e as Error).message.slice(0, 120) },
        });
        return c.json(
          { error: { message: '第三方登录失败，请重试或改用邮箱登录', code: 'OAUTH_EXCHANGE_FAILED' } },
          502,
        );
      }
    });
}
