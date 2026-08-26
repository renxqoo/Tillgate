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
import type { AccountUseCases } from '@tillgate/accounts';
import type { Identity, OAuthCallbackResult } from '@tillgate/identity';
import { OAUTH_STATE_COOKIE, safeNext } from '../contracts/oauth.js';

export interface OAuthDeps {
  /** 已配置登录方式（快照求值——前端按钮显隐与路由词表共用） */
  readonly providers: () => readonly string[];
  readonly authorize: Identity['oauth']['authorize'];
  readonly callback: Identity['oauth']['callback'];
  readonly findUser: Identity['oauth']['findUser'];
  /** 首次社交登录建号（accounts.provisionOAuthAccount） */
  readonly provision: AccountUseCases['provisionOAuthAccount'];
  /** 建号赠送 best-effort（失败不阻断登录） */
  readonly onboarding: (userId: number) => Promise<unknown>;
  readonly userStatus: (userId: number) => Promise<number | null>;
  readonly sign: (userId: number) => Promise<string>;
  /** 登录事实回写 users.last_login_at（best-effort,失败不阻断会话签发） */
  readonly touchLastLogin: (userId: number) => Promise<void>;
  readonly frontendUrl: string;
  readonly apiBase: string;
  readonly secureCookie: boolean;
  /** state cookie 寿命（秒）——与 identity state TTL 同源注入 */
  readonly stateTtlSeconds: number;
}

/** 回调后半程的用户解析（v1 G4 find-or-create）：已绑定直用；
 * 首次社交登录建号 + 建号赠送 best-effort（失败不阻断登录） */
async function resolveOAuthUserId(
  deps: Pick<OAuthDeps, 'findUser' | 'provision' | 'onboarding'>,
  input: { provider: string; result: OAuthCallbackResult },
): Promise<number> {
  const bound = await deps.findUser({ provider: input.provider, subject: input.result.subject });
  if (bound != null) return bound;
  const created = await deps.provision({
    issuer: input.provider,
    subject: input.result.subject,
    email: input.result.email ?? undefined,
    displayName: input.result.displayName ?? undefined,
  });
  await deps.onboarding(created.user.id).catch(() => {});
  return created.user.id;
}

// eslint-disable-next-line max-lines-per-function -- 路由表装配平铺:注册即数据,内联处理器为 v1 平移语义(存量棘轮)
export function oauthRoutes(deps: OAuthDeps) {
  const app = new Hono();

  app.get('/v1/oauth/providers', (c) => c.json({ providers: deps.providers() }));

  app.get('/v1/oauth/:provider/authorize', async (c) => {
    const provider = c.req.param('provider');
    if (!deps.providers().includes(provider)) {
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
    if (!deps.providers().includes(provider)) {
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
    const userId = await resolveOAuthUserId(deps, { provider, result });
    const status = await deps.userStatus(userId);
    if (status !== 0) {
      return c.json(
        { error: { code: 'client.account_unavailable', message: 'Account is unavailable' } },
        403,
      );
    }
    const token = await deps.sign(userId);
    // 登录事实回写（与密码/邮箱码/注册即登录路径同口径——四条会话签发路径统一记录）
    await deps.touchLastLogin(userId).catch(() => {});
    const next = safeNext(result.next);
    return c.redirect(`${deps.frontendUrl}${next}#token=${encodeURIComponent(token)}`);
  });

  return app;
}
