/**
 * 请求日志中间件（持久化归 @tillgate/observability）：
 * 挂 /v1/* 鉴权之前——401/429 也入日志（「记录一切 /v1 请求」语义）。
 * best-effort：写失败仅记日志不阻塞请求（排障日志不反压数据面）。
 *
 * keala 洋葱错误向上抛（Hono compose 逐层捕获继续走洋葱）——错误路径的
 * 落日志在 catch 派生事实 + finally 落库 + 原样重抛；无 Response 可读时
 * 状态码/错误码经 renderError 纯函数从错误身份派生。
 */
import {
  renderError,
  socketAddressFromContext,
  trustedClientIp,
  type Middleware,
} from '@tillgate/http';
import type { RequestLogStore } from '@tillgate/observability';
import type { GwContext } from './api-key';

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

export function requestLogMiddleware(deps: RequestLogDeps): Middleware<GwContext> {
  return async (c, next) => {
    const startedAt = Date.now();
    const { requestId } = c.state;
    // 摘要不再经 raw.clone() 嗅探：clone 分支未实现 WHATWG tee 语义，先读
    // clone 会把原始 body 标记已读 → 路由读取抛 "Body has already been read"。
    // 数据流反转：路由是唯一 body 消费者，解析后把摘要放 context，日志只取。
    let failure: { status: number; code: string } | null = null;
    try {
      await next();
    } catch (error) {
      // 记录一切语义：错误路径也落一行（状态码/码从错误身份派生），再原样上抛
      const rendered = renderError(error);
      failure = { status: rendered.status, code: rendered.code };
      throw error;
    } finally {
      const { auth } = c.state;
      const errorCode = failure?.code ?? (await sniffErrorCode(c.res));
      const summary = c.state.requestLogSummary;
      void deps.store
        .insert({
          requestId,
          userId: auth?.userId ?? null,
          apiKeyId: auth?.apiKeyId ?? null,
          method: c.method,
          path: c.path,
          statusCode: failure?.status ?? c.res?.status ?? 0,
          errorCode,
          durationMs: Date.now() - startedAt,
          attempts: c.state.inferenceAttempts ?? 1,
          channels: c.state.inferenceChannels ?? null,
          requestSummary: (summary ?? null) as unknown as Record<string, unknown> | null,
          sourceIp: trustedClientIp({
            headers: c.raw.headers,
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
    }
  };
}
