import { timingSafeEqual } from 'node:crypto';
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
 *   - 两者皆无：配置了 internalToken（BFF 服务间令牌）则必须携带 x-internal-token
 *     且恒定时间匹配（Next.js 服务端调用无 Origin 头，凭此令牌放行——这是
 *     「双缺失头放行」缺口的收口）；未配置令牌保持旧行为放行（部署兼容期）。
 *
 * 只拦「状态变更 + 来源不匹配」，不拦浏览器同源请求，也不拦非浏览器调用。
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface CsrfOptions {
  /** 受信浏览器来源（完整 origin，如 http://localhost:3000） */
  trustedOrigins: readonly string[];
  /** BFF 服务间令牌：配置后，Origin/Referer 双缺失的请求必须携带匹配的 x-internal-token */
  internalToken?: string;
}

/** 恒定时间令牌比对：长度不同直接 false（比较耗时与内容无关，防逐字节时序泄露） */
export function timingSafeTokenEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
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

    if (source) {
      if (!allowed.has(normalizeOrigin(source))) {
        throw new HttpError('CSRF_ORIGIN_DENIED');
      }
      return next();
    }
    // Origin/Referer 双缺失：非浏览器调用（BFF/脚本）。配置了内部令牌则必须匹配——
    // 浏览器攻击者无法携带该令牌（令牌只存在于服务端 env，永不下发到浏览器）。
    if (options.internalToken) {
      const provided = c.req.header('x-internal-token');
      if (!provided || !timingSafeTokenEqual(provided, options.internalToken)) {
        throw new HttpError('CSRF_TOKEN_REQUIRED');
      }
    }
    return next();
  };
}
