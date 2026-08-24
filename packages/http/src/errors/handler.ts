/**
 * Hono onError 处理器：边界层错误翻译 + 统一信封 { error: { code, message, context? } }。
 * 优先级（v1 语义保持）：坏 JSON → Hono 4xx HTTPException → 已分类错误按自身身份渲染 →
 * PG SQLSTATE（探测注入，只兜未分类错误）→ 渲染分派兜底。
 * 客户端可预期的错误必须在边界层翻译成 4xx，不得伪装 500（错误语义分级）。
 */
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  isBusinessError,
  isDefectError,
  isInfrastructureError,
  type ErrorCatalog,
} from '@tillgate/errors';
import { HttpErrors } from './catalog';
import { localeFromContext } from './locale';
import { errorBody, renderError, type FaceOverride, type RenderedError } from './render';
import { pgRejection } from './sqlstate';

/** 最小日志接口（pino 结构兼容；http 不依赖 runtime） */
export interface ErrorLogger {
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface ErrorHandlerDeps {
  /** face 装配的全量目录（缺省仅 http 自有目录） */
  readonly catalog?: ErrorCatalog;
  readonly overrides?: Readonly<Record<string, FaceOverride>>;
  /** PG SQLSTATE 探测（@tillgate/db 的 pgSqlState 装配注入；缺省无 PG 翻译——ADR-0002） */
  readonly sqlState?: (err: unknown) => string | null;
  /** 5xx 渲染时的服务端日志（缺省静默） */
  readonly logger?: ErrorLogger;
}

export function errorHandler(deps: ErrorHandlerDeps = {}) {
  return (err: Error, c: Context): Response => {
    const locale = localeFromContext(c);
    const render = (error: unknown, statusOverride?: number): Response =>
      respond(
        c,
        renderError(error, { locale, catalog: deps.catalog, overrides: deps.overrides }),
        statusOverride,
      );

    // 坏 JSON 请求体：hono validator('json') 解析失败抛 SyntaxError（手写 c.req.json() 路径同）
    if (
      err instanceof SyntaxError ||
      (err instanceof HTTPException && err.status === 400 && /JSON/i.test(err.message))
    ) {
      return render(HttpErrors.business('invalid_json'));
    }
    // 其余 Hono 内置 4xx HTTPException（bodyLimit 413 等）：保留原状态码翻成统一信封，不兜 500
    if (err instanceof HTTPException && err.status >= 400 && err.status < 500) {
      return render(
        HttpErrors.business(err.status === 413 ? 'payload_too_large' : 'invalid_request'),
        err.status,
      );
    }
    // PG 约束/值错误全局面兜底（探测注入；只兜未分类错误——已分类错误按自身身份出站，
    // 否则带 PG cause 的 BusinessError 会被 http.pg_* 覆盖丢业务码。v1 语义：已映射错误最先命中）
    if (deps.sqlState !== undefined && !isClassifiedError(err)) {
      const rejection = pgRejection(deps.sqlState(err));
      if (rejection !== null) return render(rejection);
    }
    // 渲染分派：business 按目录+override / infrastructure 503 / defect 与未知 500（细节只进日志）
    const rendered = renderError(err, { locale, catalog: deps.catalog, overrides: deps.overrides });
    if (rendered.status >= 500) {
      deps.logger?.error(
        { code: rendered.code, err: err.message, stack: err.stack },
        'unhandled error',
      );
    }
    return respond(c, rendered);
  };
}

/** 信封组装（errorBody）+ Retry-After（秒，向上取整）——全部出站错误走同一响应路径 */
function respond(c: Context, rendered: RenderedError, statusOverride?: number): Response {
  if (rendered.retryAfterMs !== undefined && rendered.retryAfterMs > 0) {
    c.header('Retry-After', String(Math.ceil(rendered.retryAfterMs / 1000)));
  }
  return c.json(errorBody(rendered), (statusOverride ?? rendered.status) as ContentfulStatusCode);
}

/** 已分类错误（三性守卫，@tillgate/errors）：有自身目录/身份的错误，PG 兜底不得接管 */
function isClassifiedError(err: unknown): boolean {
  return isBusinessError(err) || isInfrastructureError(err) || isDefectError(err);
}
