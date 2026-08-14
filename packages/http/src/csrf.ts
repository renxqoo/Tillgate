import type { MiddlewareHandler } from 'hono';
import { HttpError } from './errors.js';

/**
 * CSRF 纵深防御中间件（03 修复，client-api 与 admin-api 共用）。
 *
 * 会话基于 HttpOnly + SameSite=Lax Cookie，缺少服务端 Origin 校验时，
 * 一旦同站子域被 XSS 或浏览器 SameSite 被绕过，攻击者可借受害者会话执行状态变更。
 * 本中间件为所有「状态变更方法」校验请求来源：
 *   - 携带 Origin → 必须命中受信来源白名单，否则 403；
 *   - 无 Origin 时回退校验 Referer 的 origin；
 *   - 两者皆无（非浏览器客户端，如 curl/SDK）→ 放行（无 CSRF 风险）。
 *
 * 只拦「状态变更 + 来源不匹配」，不拦浏览器同源请求，也不拦非浏览器调用。
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface CsrfOptions {
  /** 受信浏览器来源（完整 origin，如 http://localhost:3000） */
  trustedOrigins: readonly string[];
}

/** 归一化 origin：去末尾斜杠 + 小写（scheme/host 大小写不敏感） */
function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/, '').toLowerCase();
}

function refererOrigin(referer: string): string | null {
  try {
    const url = new URL(referer);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

export function csrfProtection(options: CsrfOptions): MiddlewareHandler {
  const allowed = new Set(options.trustedOrigins.map((o) => normalizeOrigin(o)));
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method.toUpperCase())) return next();

    const origin = c.req.header('origin');
    const referer = c.req.header('referer');
    const source = origin
      ? normalizeOrigin(origin)
      : referer
        ? refererOrigin(referer)
        : null;

    if (source && !allowed.has(normalizeOrigin(source))) {
      throw new HttpError(403, 'CSRF_ORIGIN_DENIED', '跨站请求被拒绝');
    }
    return next();
  };
}
