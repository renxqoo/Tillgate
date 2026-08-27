/**
 * 协议安全三件套：
 *   - securityHeaders：统一 4 头全集（含 Cache-Control，按收紧方向归一）
 *   - corsPreflight：策略参数化（方法集/允许头/预检缓存）——必填注入，无硬编码默认
 *   - bodyParserLimit：maxBytes 必填（不藏默认上限）
 */
import { bodyLimit as honoBodyLimit } from 'hono/body-limit';
import type { MiddlewareHandler } from 'hono';
import { HttpErrors } from '../errors/catalog';
import { errorBody, renderError } from '../errors/render';

/** 安全响应头（无参数——固定策略；缓存语义对 SSE 流无害且防中间层缓存） */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', 'no-store');
};

export interface CorsConfig {
  /** 允许的 Origin 白名单（空表 = 不放行任何跨域） */
  readonly origins: readonly string[];
  /** 预检允许的方法（必填注入，不藏默认） */
  readonly methods: readonly string[];
  /** 预检允许的请求头（必填注入——部署可变值不藏默认） */
  readonly allowHeaders: readonly string[];
  /** 预检缓存秒数（必填注入；Access-Control-Max-Age 恒输出） */
  readonly maxAgeSeconds: number;
}

export function corsPreflight(config: CorsConfig): MiddlewareHandler {
  const methods = config.methods.join(', ');
  const allowHeaders = config.allowHeaders.join(', ');
  return async (c, next) => {
    const origin = c.req.header('origin');
    if (origin != null && config.origins.includes(origin)) {
      if (c.req.method === 'OPTIONS') {
        const headers: Record<string, string> = {
          'Access-Control-Allow-Origin': origin,
          Vary: 'Origin',
          'Access-Control-Allow-Methods': methods,
          'Access-Control-Allow-Headers': allowHeaders,
          'Access-Control-Max-Age': String(config.maxAgeSeconds),
        };
        return new Response(null, { status: 204, headers });
      }
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Vary', 'Origin');
    }
    await next();
  };
}

/** 超限 413 响应（经 renderError 单一渲染路径；context 携带上限供调用方自诊） */
function payloadTooLarge(maxBytes: number) {
  const rendered = renderError(HttpErrors.business('payload_too_large', { max_bytes: maxBytes }));
  return { body: errorBody(rendered), status: 413 as const };
}

/**
 * 请求体上限：按实际流过字节计数（chunked 传输编码同样受限——只查长度头可被绕过）。
 * 快路径：声明的 content-length 超限直接 413（免读流）。
 */
export function bodyParserLimit(maxBytes: number): MiddlewareHandler {
  const limit = honoBodyLimit({
    maxSize: maxBytes,
    onError: () => {
      const { body, status } = payloadTooLarge(maxBytes);
      return Response.json(body, { status });
    },
  });
  return async (c, next) => {
    const declared = Number(c.req.header('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > maxBytes) {
      const { body, status } = payloadTooLarge(maxBytes);
      return Response.json(body, { status });
    }
    return limit(c, next);
  };
}
