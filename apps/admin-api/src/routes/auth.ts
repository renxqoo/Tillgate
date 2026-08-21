/**
 * 管理员认证路由（公开组）：登录（可选 2FA 两步）/ 验码。
 * Bearer 会话——无 Cookie 无 CSRF；客户端自持 token。
 * zod 只做协议形状（长度/格式/上界），策略判定在 service/domain。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { parseAcceptLanguage, socketAddressFromContext, trustedClientIp } from '@ai-gateway/http';
import type { SessionRevocationStore } from '@ai-gateway/identity';
import type { SessionEnv } from '../middleware/session.js';
import type { AdminAuthService } from '../services/auth.service.js';

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(1).max(256),
});

const verifySchema = z.object({
  challengeId: z.string().uuid(),
  code: z.string().regex(/^\d{6}$/),
});

const sysCtx = (c: Parameters<MiddlewareHandler<SessionEnv>>[0]) =>
  ({ requestId: c.get('requestId'), actor: { kind: 'system' } as const, traceParent: null });

export function authRoutes(
  service: AdminAuthService,
  deps: { trustedProxyHops: number; session: MiddlewareHandler<SessionEnv>; revocationStore?: SessionRevocationStore },
) {
  const app = new Hono<SessionEnv>();
  const clientIp = (c: Parameters<MiddlewareHandler<SessionEnv>>[0]) =>
    trustedClientIp({
      headers: c.req.raw.headers,
      trustedProxyHops: deps.trustedProxyHops,
      // 真实 socket 地址（null = 全进程共享一桶——30 次失败锁死所有管理员，DoS 放大器）
      socketAddress: socketAddressFromContext(c),
    });

  /** 登出：吊销当前会话 jti（管理端会话即时下线——泄露令牌不再活到 TTL） */
  app.post('/v1/auth/logout', deps.session, async (c) => {
    if (deps.revocationStore) {
      const jti = c.get('sessionJti');
      const exp = c.get('sessionExp');
      await deps.revocationStore.revoke(jti, Math.max(1, exp - Math.floor(Date.now() / 1000)));
    }
    return c.json({ ok: true });
  });

  app.post('/v1/auth/login', async (c) => {
    const body = loginSchema.parse(await c.req.json());
    const result = await service.login(sysCtx(c), { ...body, ip: clientIp(c), locale: parseAcceptLanguage(c.req.header('accept-language')) });
    if (result.kind === 'code_required') {
      return c.json({ twoFactorRequired: true, challengeId: result.challengeId });
    }
    return c.json({ token: result.token, adminId: result.adminId });
  });

  app.post('/v1/auth/login/verify', async (c) => {
    const body = verifySchema.parse(await c.req.json());
    const result = await service.verifyLoginCode(sysCtx(c), body);
    return c.json({ token: result.token, adminId: result.adminId });
  });

  return app;
}
