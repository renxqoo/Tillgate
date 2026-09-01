/**
 * 协议安全三件套 + body 预算：
 *   - securityHeaders：统一 4 头全集（含 Cache-Control，按收紧方向归一）
 *   - corsPreflight：策略参数化（方法集/允许头/预检缓存）——必填注入，无硬编码默认
 *   - bodyParser：maxBytes 必填（不藏默认上限）——声明长度快查 + 读取侧流式计数
 *
 * keala 的请求体不可替换（c.raw 只读），流式计数由 bodyParser 插件在读取侧
 * 强制（readBodyLimited：chunked 同样受限）；所有 body 消费必须走 c.req.*
 * facade（直读 c.raw.body 会绕过预算）。
 */
import { createBodyParser, isHttpError, readBodyLimited } from 'keala';
import type { Plugin } from 'keala';
import type { Middleware } from '../framework/keala';
import { HttpErrors } from '../errors/catalog';
import { errorBody, renderError } from '../errors/render';

/** 安全响应头（无参数——固定策略；缓存语义对 SSE 流无害且防中间层缓存）。
 * 前置 staged（keala 错误向上抛时 next 后置写会被跳过——错误响应同样要带安全头） */
export const securityHeaders: Middleware = async (c, next) => {
  c.set('X-Content-Type-Options', 'nosniff');
  c.set('X-Frame-Options', 'DENY');
  c.set('Referrer-Policy', 'no-referrer');
  c.set('Cache-Control', 'no-store');
  await next();
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

export function corsPreflight(config: CorsConfig): Middleware {
  const methods = config.methods.join(', ');
  const allowHeaders = config.allowHeaders.join(', ');
  return async (c, next) => {
    const origin = c.get('origin');
    if (origin != null && config.origins.includes(origin)) {
      if (c.method === 'OPTIONS') {
        const headers: Record<string, string> = {
          'Access-Control-Allow-Origin': origin,
          Vary: 'Origin',
          'Access-Control-Allow-Methods': methods,
          'Access-Control-Allow-Headers': allowHeaders,
          'Access-Control-Max-Age': String(config.maxAgeSeconds),
        };
        return new Response(null, { status: 204, headers });
      }
      c.set('Access-Control-Allow-Origin', origin);
      c.set('Vary', 'Origin');
    }
    await next();
  };
}

/** 超限 413 响应（经 renderError 单一渲染路径；context 携带上限供调用方自诊） */
function payloadTooLargeResponse(maxBytes: number): Response {
  const rendered = renderError(HttpErrors.business('payload_too_large', { max_bytes: maxBytes }));
  return Response.json(errorBody(rendered), { status: 413 });
}

/**
 * body 预算门（声明快查 + 无声明流式预读计数，均出同款 payload_too_large 信封）：
 *   - 声明 content-length 超限 → 免读流直接 413；
 *   - 无声明长度（chunked）→ 经 readBodyLimited 预读计数（parser memo 缓存，
 *     handler 后续 c.req.* 读缓存，不双消费），超限翻译成带 max_bytes 的信封。
 * 与 bodyParser(maxBytes) 成对注册（流读取侧兜底 + facade 提供）。
 * 已知差异：声明长度谎报偏小而实际超限时，读取侧 413 信封不带 max_bytes context
 * （keala readBodyLimited 的错误不含限值）——见 MIGRATION §4-8。
 */
export function bodyParserLimit(maxBytes: number): Middleware {
  return async (c, next) => {
    const declared = c.reqLength;
    if (declared !== undefined && declared > maxBytes) return payloadTooLargeResponse(maxBytes);
    if (declared === undefined && c.raw.body != null) {
      try {
        await readBodyLimited(c, maxBytes);
      } catch (error) {
        if (isHttpError(error) && error.status === 413) throw payloadTooLargeError(maxBytes);
        throw error;
      }
    }
    await next();
  };
}

/** 超限业务错误（errorHandling 渲染信封用） */
function payloadTooLargeError(maxBytes: number) {
  return HttpErrors.business('payload_too_large', { max_bytes: maxBytes });
}

/**
 * body 读取侧流式计数插件（json/text/form 同一限值；chunked 传输同样受限）。
 * 与 bodyParserLimit(maxBytes) 成对注册；协议栈先装本插件，路由内一切 body
 * 读取走 c.req.* facade。
 */
export function bodyParser(maxBytes: number): Plugin {
  return createBodyParser({ jsonLimit: maxBytes, textLimit: maxBytes, formLimit: maxBytes });
}
