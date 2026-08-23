/**
 * 请求日志中间件（v1 request-log 迁移；持久化归 @tokenlens/observability）：
 * 挂 /v1/* 鉴权之前——401/429 也入日志（「记录一切 /v1 请求」语义）。
 * best-effort：写失败仅记日志不阻塞请求（排障日志不反压数据面）。
 */
import type { MiddlewareHandler } from 'hono';
import { socketAddressFromContext, trustedClientIp } from '@tokenlens/http';
import type { RequestLogStore } from '@tokenlens/observability';
import type { AuthEnv } from './api-key';

export interface RequestLogDeps {
  store: RequestLogStore;
  logger?: { error(obj: unknown, msg: string): void };
  trustedProxyHops: number;
}

/** POST 请求的摘要字段（model 截 64 字符；仅 body.model 为 string 时采集） */
function requestSummaryOf(
  method: string,
  body: unknown,
): { model: string; stream: boolean; max_tokens: number | null } | undefined {
  if (method !== 'POST' || body == null || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record.model !== 'string') return undefined;
  return {
    model: record.model.slice(0, 64),
    stream: record.stream === true,
    max_tokens: typeof record.max_tokens === 'number' ? record.max_tokens : null,
  };
}

export function requestLogMiddleware(deps: RequestLogDeps): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const startedAt = Date.now();
    const requestId = c.get('requestId');
    // 摘要嗅探经 raw.clone()——不吞原始流（multipart 路由随后仍可 formData()；
    // v1 同款：clone 上 json() 失败即无摘要，原始 body 不受影响）
    let parsedBody: unknown = null;
    if (c.req.method === 'POST') {
      parsedBody = await c.req.raw.clone().json().catch(() => null);
    }
    await next();
    const auth = c.get('auth');
    let errorCode: string | null = null;
    // 仅嗅探 JSON 响应的 error.code（SSE/二进制不 clone 流——数据面不因日志碰流）
    const contentType = c.res?.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      try {
        const body = (await c.res!.clone().json()) as { error?: { code?: string } };
        errorCode = body?.error?.code ?? null;
      } catch {
        errorCode = null;
      }
    }
    const summary = requestSummaryOf(c.req.method, parsedBody);
    void deps.store
      .insert({
        requestId,
        userId: auth?.userId ?? null,
        apiKeyId: auth?.apiKeyId ?? null,
        method: c.req.method,
        path: c.req.path,
        statusCode: c.res?.status ?? 0,
        errorCode,
        durationMs: Date.now() - startedAt,
        requestSummary: summary ?? null,
        sourceIp: trustedClientIp({
          headers: c.req.raw.headers,
          trustedProxyHops: deps.trustedProxyHops,
          socketAddress: socketAddressFromContext(c),
        }),
      })
      .catch((error: unknown) => {
        deps.logger?.error({ err: String(error), requestId }, 'request log write failed (best-effort)');
      });
  };
}
