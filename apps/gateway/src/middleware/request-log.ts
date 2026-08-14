import type { MiddlewareHandler } from 'hono';
import type { Db } from '@ai-gateway/db';
import type { Logger } from '@ai-gateway/core';
import { writeRequestLog, truncateSummary } from '../lib/request-log.js';
import { sourceIp } from './auth-failure-guard.js';
import type { AuthEnv } from './auth.js';

/**
 * 请求日志中间件：在每个 /v1/* 请求完成后写一条 request_logs（data-model §3.13）。
 *
 *   - await next() 之前缓存请求摘要（model/stream/max_tokens，不含敏感内容）
 *   - await next() 之后读 status / 计算耗时 / 提取错误码
 *   - fire-and-forget：写日志失败不阻塞响应
 */
export function requestLogMiddleware(db: Db, logger: Logger): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const start = Date.now();
    const requestId = c.var.requestId;

    // next() 之后从已校验的 body 提取摘要（validator 解析后缓存在 c.req.valid）
    // 这样不重复读 body，不破坏下游路由
    await next();
    const durationMs = Date.now() - start;

    let requestSummary: Record<string, unknown> | null = null;
    if (c.req.method === 'POST') {
      try {
        // c.req.valid('json') 返回 zod 校验后的 body（validator 缓存）
        // 中间件层无类型信息，用 unknown 断言
        const raw = (c.req as { valid: (k: string) => unknown }).valid('json') as Record<
          string,
          unknown
        > | null;
        if (raw && typeof raw === 'object') {
          requestSummary = truncateSummary({
            model: raw.model,
            stream: raw.stream,
            max_tokens: raw.max_tokens,
            temperature: raw.temperature,
            messageCount: Array.isArray(raw.messages) ? raw.messages.length : undefined,
            inputLength: raw.input ? String(raw.input).length : undefined,
          }) as Record<string, unknown>;
        }
      } catch {
        // 未走 validator 或非 JSON → 跳过
      }
    }

    const path = c.req.path;
    if (!path.startsWith('/v1/')) return;

    const status = c.res.status;
    const auth = c.var.auth;

    // 07 修复：来源级鉴权失败限流的 429（无 auth 上下文）不写 request_logs，
    // 避免攻击者用海量随机 Key 刷 429 打爆日志库。401（前 N 次失败）仍记录以观测爆破。
    if (status === 429 && !auth) return;

    // 错误码：只用 HTTP 状态码推断（不 clone 读 body）。
    // c.res.clone() + .json() 会缓冲整个流式 Response（破坏 SSE 逐块推送）。
    const errorCode = status >= 400 ? `http_${status}` : null;

    void writeRequestLog(
      db,
      {
        requestId,
        userId: auth?.userId ?? null,
        apiKeyId: auth?.apiKeyId ?? null,
        sourceIp: sourceIp(c),
        method: c.req.method,
        path,
        statusCode: status,
        errorCode,
        durationMs,
        requestSummary,
      },
      logger,
    );
  };
}

export { truncateSummary };
