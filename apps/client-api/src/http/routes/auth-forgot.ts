/**
 * 找回密码动词(公开,链接制):
 *   forgot {email} → IP 限频 + 邮箱 60s 冷却 → 账号存在且未封禁才签发一次性重置令牌
 *   (32B 随机,SHA-256 落 Redis,TTL 30 分钟)并向邮箱投递重置链接
 *   `${resetLinkBase}/reset-password?token=…`(基地址随部署配置——生产域名/本地端口
 *   各自正确);「不存在/已封禁」走哑成功(同款响应,不泄漏注册与封禁状态)。
 *   forgot/reset {token, password} → GETDEL 原子消费令牌(单次,重放即失效)→
 *   密码策略 → passwords.reset(免旧密,推进 user realm 吊销线 = 全网旧会话即刻
 *   下线)→ 不自动登录(用户持链接来自邮箱,设完走登录页)。
 * 配置前置:SMTP 与控制台基地址(OAUTH_FRONTEND_URL)缺一即 503 fail-closed
 * ——发不出链接的功能绝不静默降级。
 */
import { Hono } from 'hono';
import { jsonBody } from '@tillgate/http';
import { assertPasswordPolicy } from '@tillgate/identity';
import { forgotSchema, forgotResetSchema } from '../contracts/auth.js';
import { clientErrors } from '../error-face.js';
import type { SessionEnv } from '../middleware/session.js';
import { clientIpOf, localeOf, type AuthDeps } from './auth.js';

// eslint-disable-next-line max-lines-per-function -- 路由表装配平铺:注册即数据,内联处理器为 v1 平移语义(存量棘轮)
export function forgotRoutes(deps: AuthDeps) {
  const app = new Hono<SessionEnv>();

  app.post('/v1/auth/forgot', jsonBody(forgotSchema), async (c) => {
    const body = c.req.valid('json');
    const ip = clientIpOf(deps, c);

    // SMTP 未生效或控制台基地址未配——fail-closed,不静默降级（快照动态判定）
    const sendResetLink = deps.smtpReady() ? deps.sendResetLink : null;
    if (sendResetLink == null || deps.resetLinkBase == null) {
      throw clientErrors.business('reset_link_unavailable');
    }

    // IP 限频(与注册共用 Redis 计数器,独立键)
    let hits: number;
    try {
      hits = await deps.registerLimiter.hit(`forgot-ip:${ip}`, deps.registerWindowSeconds);
    } catch {
      throw clientErrors.business('rate_counter_unavailable');
    }
    if (hits > deps.registerIpLimitPerHour) {
      throw clientErrors.business('register_rate_limited', undefined, {
        retryAfterMs: deps.registerWindowSeconds * 1_000,
      });
    }
    // 邮箱冷却:哑/真实同键同响应(存在性探测在两侧得到一致的 429)
    let mailHits: number;
    try {
      mailHits = await deps.registerLimiter.hit(`forgot-mail:${body.email}`, 60);
    } catch {
      throw clientErrors.business('rate_counter_unavailable');
    }
    if (mailHits > 1) {
      throw clientErrors.business('register_rate_limited', undefined, { retryAfterMs: 60_000 });
    }

    const user = await deps.userByEmail(body.email);
    // 不存在或封禁:哑成功(不签发、不投递)——注册状态与封禁状态都不泄漏
    if (user == null || user.status !== 0) {
      return c.json({ ok: true });
    }

    const token = await deps.issueResetToken(user.id);
    const url = `${deps.resetLinkBase.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
    await sendResetLink(body.email, url, {
      ip: ip ?? 'unknown',
      locale: localeOf(c),
      ttlMinutes: deps.resetTokenTtlMinutes,
    });
    return c.json({ ok: true });
  });

  app.post('/v1/auth/forgot/reset', jsonBody(forgotResetSchema), async (c) => {
    const body = c.req.valid('json');
    assertPasswordPolicy(body.password, deps.passwordPolicy);
    const userId = await deps.consumeResetToken(body.token);
    if (userId == null) {
      // 令牌无效/过期/已用——统一口径,不区分原因
      throw clientErrors.business('reset_token_invalid');
    }
    await deps.resetPassword({ userId, realm: 'user', newPassword: body.password });
    return c.json({ ok: true });
  });

  return app;
}
