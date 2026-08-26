/**
 * 请求日志中间件（v1 request-log 迁移；持久化归 @tillgate/observability）：
 * 挂 /v1/* 鉴权之前——401/429 也入日志（「记录一切 /v1 请求」语义）。
 * best-effort：写失败仅记日志不阻塞请求（排障日志不反压数据面）。
 */
import type { MiddlewareHandler } from 'hono';
import { socketAddressFromContext, trustedClientIp } from '@tillgate/http';
import type { RequestLogStore } from '@tillgate/observability';
import type { AuthEnv } from './api-key';

export interface RequestLogDeps {
  store: RequestLogStore;
  logger?: { error(obj: unknown, msg: string): void };
  trustedProxyHops: number;
}

export interface RequestSummary {
  model: string;
  stream: boolean;
  max_tokens: number | null;
}

/** POST 请求的摘要（model 截 64 字符；仅 body.model 为 string 时采集）——
 * 由路由解析 body 后构造放入 context（requestLogSummary），日志面不读 body */
export function requestSummaryOf(method: string, body: unknown): RequestSummary | undefined {
  if (method !== 'POST' || body == null || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record.model !== 'string') return undefined;
  return {
    model: record.model.slice(0, 64),
    stream: record.stream === true,
    max_tokens: typeof record.max_tokens === 'number' ? record.max_tokens : null,
  };
}

/** 嗅探 JSON 响应的 error.code（SSE/二进制不 clone 流——数据面不因日志碰流；失败 → null） */
async function sniffErrorCode(res: Response | undefined): Promise<string | null> {
  const contentType = res?.headers.get('content-type') ?? '';
  if (res == null || !contentType.includes('application/json')) return null;
  try {
    const body = (await res.clone().json()) as { error?: { code?: string } };
    return body?.error?.code ?? null;
  } catch {
    return null;
  }
}

export function requestLogMiddleware(deps: RequestLogDeps): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const startedAt = Date.now();
    const requestId = c.get('requestId');
    // 摘要不再经 raw.clone() 嗅探：@hono/node-server 的 clone 未实现 WHATWG tee
    // 语义，先读 clone 分支会把原始 body 标记已读 → 路由 c.req.json() 抛
    // "Body has already been read" → 高并发下大面积 400（live-fire X11 实锤）。
    // 数据流反转：路由是唯一 body 消费者，解析后把摘要放 context，日志只取。
    await next();
    const auth = c.get('auth');
    const errorCode = await sniffErrorCode(c.res);
    const summary = c.get('requestLogSummary');
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
        requestSummary: (summary ?? null) as unknown as Record<string, unknown> | null,
        sourceIp: trustedClientIp({
          headers: c.req.raw.headers,
          trustedProxyHops: deps.trustedProxyHops,
          socketAddress: socketAddressFromContext(c),
        }),
      })
      .catch((error: unknown) => {
        deps.logger?.error(
          { err: String(error), requestId },
          'request log write failed (best-effort)',
        );
      });
  };
}
