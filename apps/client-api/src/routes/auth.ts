/**
 * 认证路由：注册/登录（公开，支持两步验证码流）/ 验码端点 / 能力探测 / 改密（会话）。
 * zod 只做协议形状（长度/格式/上界），策略判定在 service/domain。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { socketAddressFromContext, trustedClientIp } from '@ai-gateway/http';
import type { SessionRevocationStore } from '@ai-gateway/identity';
import { userCtxOf } from './ctx.js';
import type { SessionEnv } from '../middleware/session.js';
import type { AuthService } from '../services/auth.service.js';

const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(1).max(128),
  captchaToken: z.string().max(4096).optional(),
  /** 邀请归因 aff 码（u{base36}；非法形态由 domain 规则拒绝，不阻断注册） */
  aff: z.string().trim().max(32).optional(),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(1).max(128),
});

const verifySchema = z.object({
  challengeId: z.string().uuid(),
  code: z.string().trim().regex(/^\d{6}$/, '验证码为 6 位数字'),
  aff: z.string().trim().max(32).optional(),
});

const passwordSchema = z.object({
  oldPassword: z.string().min(1).max(128),
  newPassword: z.string().min(1).max(128),
});

const sysCtx = (c: Parameters<MiddlewareHandler<SessionEnv>>[0]) =>
  ({ requestId: c.get('requestId'), actor: { kind: 'system' } as const, traceParent: null });

export function authRoutes(
  service: AuthService,
  deps: {
    session: MiddlewareHandler<SessionEnv>;
    trustedProxyHops: number;
    /** jti 吊销（登出即时下线；缺省 logout 仅客户端弃令牌） */
    revocationStore?: SessionRevocationStore;
  },
) {
  const app = new Hono<SessionEnv>();
  // 真实 socket 对端地址必须注入：置 null 时全部请求落到进程级常量桶——
  // 注册 5 次/小时与登录 IP 锁退化为「全站一个桶」的自伤开关（app.request 测试 → null 合法）
  const clientIp = (c: Parameters<MiddlewareHandler<SessionEnv>>[0]) =>
    trustedClientIp({
      headers: c.req.raw.headers,
      trustedProxyHops: deps.trustedProxyHops,
      socketAddress: socketAddressFromContext(c),
    });

  /** 前端能力探测（登录页/注册页按钮渲染依据；无个人数据） */
  app.get('/v1/auth/capabilities', (c) => c.json(service.capabilities()));

  /** 登出：吊销当前会话 jti（Redis 键存活至令牌自然过期——之后 token 自然失效） */
  app.post('/v1/auth/logout', deps.session, async (c) => {
    if (deps.revocationStore) {
      const jti = c.get('sessionJti');
      const exp = c.get('sessionExp');
      await deps.revocationStore.revoke(jti, Math.max(1, exp - Math.floor(Date.now() / 1000)));
    }
    return c.json({ ok: true });
  });

  app.post('/v1/auth/register', async (c) => {
    const body = registerSchema.parse(await c.req.json());
    const result = await service.register(sysCtx(c), { ...body, ip: clientIp(c) });
    return c.json(result, result.kind === 'success' ? 201 : 200);
  });

  app.post('/v1/auth/register/verify', async (c) => {
    const body = verifySchema.parse(await c.req.json());
    const result = await service.verifyRegistration(sysCtx(c), body);
    return c.json(result, 201);
  });

  app.post('/v1/auth/login', async (c) => {
    const body = loginSchema.parse(await c.req.json());
    const result = await service.login(sysCtx(c), { ...body, ip: clientIp(c) });
    return c.json(result);
  });

  app.post('/v1/auth/login/verify', async (c) => {
    const body = verifySchema.parse(await c.req.json());
    const result = await service.verifyLogin(sysCtx(c), body);
    return c.json(result);
  });

  app.post('/v1/auth/password', deps.session, async (c) => {
    const body = passwordSchema.parse(await c.req.json());
    const result = await service.changePassword(userCtxOf(c), {
      userId: c.get('userId'),
      oldPassword: body.oldPassword,
      newPassword: body.newPassword,
    });
    return c.json(result);
  });

  return app;
}
