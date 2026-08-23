/**
 * OAuth 路由（公开）：
 *   GET /v1/oauth/providers —— 已配置的登录方式（前端按钮显隐）
 *   GET /v1/oauth/:provider/authorize?next=/path —— 302 授权页（state cookie 双提交）
 *   GET /v1/oauth/:provider/callback?code&state —— 验 state → find-or-create 建号
 *     （赠送 best-effort）→ 会话 token 经 URL fragment 回传前端（#token=…，
 *     不进服务端日志/Referer）。cookie 双提交比对与 next 归一归本层（identity D7）。
 */
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AccountUseCases } from '@tokenlens/accounts';
import type { Identity } from '@tokenlens/identity';
import { OAUTH_STATE_COOKIE, safeNext } from '../contracts/oauth.js';

export interface OAuthDeps {
  readonly providers: readonly string[];
  readonly authorize: Identity['oauth']['authorize'];
  readonly callback: Identity['oauth']['callback'];
  readonly findUser: Identity['oauth']['findUser'];
  /** 首次社交登录建号（accounts.provisionOAuthAccount） */
  readonly provision: AccountUseCases['provisionOAuthAccount'];
  /** 建号赠送 best-effort（失败不阻断登录） */
  readonly onboarding: (userId: number) => Promise<unknown>;
  readonly userStatus: (userId: number) => Promise<number | null>;
  readonly sign: (userId: number) => Promise<string>;
  readonly frontendUrl: string;
  readonly apiBase: string;
  readonly secureCookie: boolean;
  /** state cookie 寿命（秒）——与 identity state TTL 同源注入 */
  readonly stateTtlSeconds: number;
}

export function oauthRoutes(deps: OAuthDeps) {
  const app = new Hono();

  app.get('/v1/oauth/providers', (c) => c.json({ providers: deps.providers }));

  app.get('/v1/oauth/:provider/authorize', async (c) => {
    const provider = c.req.param('provider');
    if (!deps.providers.includes(provider)) {
      return c.json(
        { error: { code: 'client.oauth_unknown', message: 'Unknown login method' } },
        404,
      );
    }
    const { url, state } = await deps.authorize({
      provider,
      redirectUri: `${deps.apiBase}/v1/oauth/${provider}/callback`,
      next: safeNext(c.req.query('next')),
    });
    setCookie(c, OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/v1/oauth',
      maxAge: deps.stateTtlSeconds,
      secure: deps.secureCookie,
    });
    return c.redirect(url);
  });

  app.get('/v1/oauth/:provider/callback', async (c) => {
    const provider = c.req.param('provider');
    if (!deps.providers.includes(provider)) {
      return c.json(
        { error: { code: 'client.oauth_unknown', message: 'Unknown login method' } },
        404,
      );
    }
    // 双提交第一因子：cookie state 必须与 query state 一致（cookie 缺失/不符 = 拒绝）
    const cookieState = getCookie(c, OAUTH_STATE_COOKIE);
    const queryState = c.req.query('state') ?? '';
    if (cookieState == null || cookieState !== queryState) {
      return c.json(
        { error: { code: 'client.oauth_state_mismatch', message: 'Login state mismatch' } },
        403,
      );
    }
    // identity 半程：redis 单次消费 state + code 换 profile（上游失败 502）
    const result = await deps.callback({
      provider,
      code: c.req.query('code') ?? '',
      state: queryState,
      redirectUri: `${deps.apiBase}/v1/oauth/${provider}/callback`,
    });
    deleteCookie(c, OAUTH_STATE_COOKIE, { path: '/v1/oauth' });

    // find-or-create：已绑定直用；首次建号（v1 G4：find-or-create + 建号赠送归 app）
    let userId = await deps.findUser({ provider, subject: result.subject });
    if (userId == null) {
      const created = await deps.provision({
        issuer: provider,
        subject: result.subject,
        email: result.email ?? undefined,
        displayName: result.displayName ?? undefined,
      });
      userId = created.user.id;
      await deps.onboarding(userId).catch(() => undefined);
    }
    const status = await deps.userStatus(userId);
    if (status !== 0) {
      return c.json(
        { error: { code: 'client.account_unavailable', message: 'Account is unavailable' } },
        403,
      );
    }
    const token = await deps.sign(userId);
    const next = safeNext(result.next);
    return c.redirect(`${deps.frontendUrl}${next}#token=${encodeURIComponent(token)}`);
  });

  return app;
}
