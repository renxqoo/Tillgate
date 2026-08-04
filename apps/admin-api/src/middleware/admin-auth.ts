import type { MiddlewareHandler } from 'hono';

/**
 * admin-api 鉴权中间件（S4）。
 *
 * 管理端所有 /api/admin/* 接口必须带有效凭证。
 * 一期务实方案：API Token（环境变量 ADMIN_API_TOKEN）。
 *   - 凭证来源：Authorization: Bearer <token> 或 X-Admin-Token: <token>
 *   - fail-closed：ADMIN_API_TOKEN 未配置或为空 → 503（绝不放行，防配置遗漏导致裸奔）
 *   - 后续 console 上线后切 HttpOnly Cookie JWT（role=admin），本中间件替换实现
 *
 * 时序安全：用 timingSafeEqual 防 token 时序攻击（非常量时间比较泄露前缀）。
 */
import { timingSafeEqual } from 'node:crypto';

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export const adminAuthMiddleware = (adminToken: string | undefined): MiddlewareHandler => async (c, next) => {
  // fail-closed：未配置 token → 503（绝不放行）
  if (!adminToken || adminToken.length === 0) {
    return c.json({ error: { message: '管理端未配置 ADMIN_API_TOKEN，拒绝服务（fail-closed）', code: 'ADMIN_TOKEN_NOT_CONFIGURED' } }, 503);
  }
  // 提取凭证：Bearer 或 X-Admin-Token
  const authHeader = c.req.header('authorization');
  let token: string | null = null;
  if (authHeader) {
    const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    token = m?.[1] ?? null;
  }
  if (!token) {
    token = c.req.header('x-admin-token') ?? null;
  }
  if (!token) {
    return c.json({ error: { message: '缺少管理端凭证', code: 'UNAUTHORIZED' } }, 401);
  }
  // 常量时间比较（防时序攻击）
  if (!safeEqual(token, adminToken)) {
    return c.json({ error: { message: '管理端凭证无效', code: 'UNAUTHORIZED' } }, 401);
  }
  await next();
};
