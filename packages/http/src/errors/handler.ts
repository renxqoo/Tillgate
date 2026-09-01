/**
 * 最外层错误中间件：边界层错误翻译 + 统一信封 { error: { code, message, context? } }。
 * 优先级：坏 JSON → keala/Hono 4xx HTTP 错误 → 已分类错误按自身身份渲染 →
 * PG SQLSTATE（探测注入，只兜未分类错误）→ 渲染分派兜底。
 * 客户端可预期的错误必须在边界层翻译成 4xx，不得伪装 500（错误语义分级）。
 *
 * keala 的 onError 是事件监听器（日志面），不产生响应——错误响应由本中间件
 * 在洋葱最外层 try/catch 产生；各 app 必须把它注册为第一个全局中间件。
 */
import { isHttpError } from 'keala';
import type { Context } from 'keala';
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
import type { Middleware } from '../framework/keala';

/** 最小日志接口（pino 结构兼容；http 不依赖 runtime） */
export interface ErrorLogger {
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface ErrorHandlerDeps {
  /** face 装配的全量目录（缺省仅 http 自有目录） */
  readonly catalog?: ErrorCatalog;
  readonly overrides?: Readonly<Record<string, FaceOverride>>;
  /** PG SQLSTATE 探测（@tillgate/db 的 pgSqlState 装配注入；缺省无 PG 翻译） */
  readonly sqlState?: (err: unknown) => string | null;
  /** 5xx 渲染时的服务端日志（缺省静默） */
  readonly logger?: ErrorLogger;
}

export function errorHandling(deps: ErrorHandlerDeps = {}): Middleware {
  return async (c, next) => {
    try {
      await next();
    } catch (error) {
      return translate(error, c, deps);
    }
  };
}

/** 错误翻译主体（信封渲染的单一出口） */
function translate(error: unknown, c: Context, deps: ErrorHandlerDeps): Response {
  const locale = localeFromContext(c);
  const render = (err: unknown, statusOverride?: number): Response =>
    respond(
      c,
      renderError(err, { locale, catalog: deps.catalog, overrides: deps.overrides }),
      statusOverride,
    );

  const framework = frameworkErrorResponse(error, render);
  if (framework !== undefined) return framework;
  // PG 约束/值错误全局面兜底（探测注入；只兜未分类错误——已分类错误按自身身份出站，
  // 否则带 PG cause 的 BusinessError 会被 http.pg_* 覆盖丢业务码）
  if (deps.sqlState !== undefined && !isClassifiedError(error)) {
    const rejection = pgRejection(deps.sqlState(error));
    if (rejection !== null) return render(rejection);
  }
  // 渲染分派：business 按目录+override / infrastructure 503 / defect 与未知 500（细节只进日志）
  const rendered = renderError(error, { locale, catalog: deps.catalog, overrides: deps.overrides });
  if (rendered.status >= 500) {
    // context 进日志（如 no_available_channel 的 upstream_code=channel_budget_exhausted）：
    // 5xx 终局原因运营排障必需——出站信封有 context，日志面不得丢失同一事实
    deps.logger?.error(
      {
        code: rendered.code,
        ...(rendered.context !== undefined ? { context: rendered.context } : {}),
        err: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'unhandled error',
    );
  }
  return respond(c, rendered);
}

/**
 * 框架层 4xx 翻译：坏 JSON（createBodyParser facade 400 / 手写 JSON.parse 的
 * SyntaxError）→ invalid_json；其余 keala 4xx（body 预算 413 等）保留原状态码
 * 翻成统一信封，不兜 500。
 */
function frameworkErrorResponse(
  error: unknown,
  render: (err: unknown, statusOverride?: number) => Response,
): Response | undefined {
  if (error instanceof SyntaxError) return render(HttpErrors.business('invalid_json'));
  if (!isHttpError(error) || error.status < 400 || error.status >= 500) return undefined;
  if (error.status === 400 && /JSON/i.test(error.message)) {
    return render(HttpErrors.business('invalid_json'));
  }
  return render(
    HttpErrors.business(error.status === 413 ? 'payload_too_large' : 'invalid_request'),
    error.status,
  );
}

/** 信封组装（errorBody）+ Retry-After（秒，向上取整）——全部出站错误走同一响应路径 */
function respond(c: Context, rendered: RenderedError, statusOverride?: number): Response {
  if (rendered.retryAfterMs !== undefined && rendered.retryAfterMs > 0) {
    c.set('Retry-After', String(Math.ceil(rendered.retryAfterMs / 1000)));
  }
  return c.json(errorBody(rendered), statusOverride ?? rendered.status);
}

/** 已分类错误（三性守卫，@tillgate/errors）：有自身目录/身份的错误，PG 兜底不得接管 */
function isClassifiedError(err: unknown): boolean {
  return isBusinessError(err) || isInfrastructureError(err) || isDefectError(err);
}

/**
 * 404 渲染器（app.notFound 用）：keala 的 notFound 在中间件链之外执行，throw
 * 不可达 errorHandling——必须在此直接产出与错误链同款的本地化信封。
 * context 可携带 path 等定位事实（gateway 形态）。
 */
export function notFoundResponse(
  c: Context,
  deps: Pick<ErrorHandlerDeps, 'catalog' | 'overrides'> = {},
  context?: Record<string, string>,
): Response {
  const locale = localeFromContext(c);
  const rendered = renderError(HttpErrors.business('not_found', context), {
    locale,
    catalog: deps.catalog,
    overrides: deps.overrides,
  });
  return c.json(errorBody(rendered), rendered.status);
}
