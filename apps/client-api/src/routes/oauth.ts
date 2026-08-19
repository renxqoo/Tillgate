/**
 * OAuth 路由（公开）：
 *   GET /v1/oauth/providers —— 已配置的登录方式（前端按钮显隐）
 *   GET /v1/oauth/:provider/authorize?next=/path —— 302 授权页（state cookie 双提交）
 *   GET /v1/oauth/:provider/callback?code&state —— 验 state → 会话 token 经
 *     URL fragment 回传前端（#token=…，不进服务端日志/Referer）
 */
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import { systemContext } from '@ai-gateway/service';
import type { OAuthProviderName, OAuthService } from '../services/oauth.service.js';

const STATE_COOKIE = 'ag_oauth_state';

const providerParamSchema = z.object({
  provider: z.enum(['github', 'google']),
});

function parseProvider(raw: string): OAuthProviderName | null {
  return providerParamSchema.safeParse({ provider: raw }).success
    ? (raw as OAuthProviderName)
    : null;
}

export function oauthRoutes(service: OAuthService, deps: { secureCookie: boolean }) {
  const app = new Hono();

  app.get('/v1/oauth/providers', (c) => c.json({ providers: service.providers() }));

  app.get('/v1/oauth/:provider/authorize', async (c) => {
    const provider = parseProvider(c.req.param('provider'));
    if (!provider) return c.json({ error: { code: 'oauth_unknown', message: '未知的登录方式' } }, 404);
    try {
      const { url, state } = await service.authorize(provider, c.req.query('next') ?? '');
      setCookie(c, STATE_COOKIE, state, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/v1/oauth',
        maxAge: 600,
        secure: deps.secureCookie,
      });
      return c.redirect(url);
    } catch (e) {
      // 未配置的 provider 404（服务层 AppError 统一形状；这里直接透传语义）
      const status = (e as { status?: number }).status ?? 502;
      const code = (e as { code?: string }).code ?? 'oauth_failed';
      return c.json({ error: { code, message: '该登录方式不可用' } }, status as 404);
    }
  });

  app.get('/v1/oauth/:provider/callback', async (c) => {
    const provider = parseProvider(c.req.param('provider'));
    if (!provider) return c.json({ error: { code: 'oauth_unknown', message: '未知的登录方式' } }, 404);
    try {
      const result = await service.callback(
        systemContext(c.req.header('x-request-id') ?? 'oauth-callback'),
        {
          provider,
          code: c.req.query('code') ?? '',
          state: c.req.query('state') ?? '',
          cookieState: getCookie(c, STATE_COOKIE),
        },
      );
      deleteCookie(c, STATE_COOKIE, { path: '/v1/oauth' });
      return c.redirect(result.redirectUrl);
    } catch (e) {
      const status = (e as { status?: number }).status ?? 502;
      const code = (e as { code?: string }).code ?? 'oauth_failed';
      return c.json({ error: { code, message: '第三方登录失败，请重试' } }, status as 404);
    }
  });

  return app;
}
