import type { MiddlewareHandler } from 'hono';
import type { Db } from '@ai-gateway/db';
import type { Logger } from '@ai-gateway/logger';
import { writeRequestLog, truncateSummary } from '../lib/request-log.js';
import type { AuthEnv } from './auth.js';

/**
 * 请求日志中间件：在每个 /v1/* 请求完成后写一条 request_logs（data-model §3.13）。
 *
 *   - await next() 之后 c.res 已 finalize，读 status/计算 duration
 *   - fire-and-forget：writeRequestLog 内部 try-catch，失败仅记日志，不阻塞响应
 *   - 30 天滚动（data-model §3.13）：P1 按月分区 + 定时清理
 *
 *   只记录对外 API 请求（/v1/*），不记录 /healthz /oauth/token（排障价值低，减少噪声）。
 */
export function requestLogMiddleware(db: Db, logger: Logger): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const start = Date.now();
    const requestId = c.var.requestId;
    await next();
    const durationMs = Date.now() - start;

    // 只记录对外代理请求（/v1/*）
    const path = c.req.path;
    if (!path.startsWith('/v1/')) return;

    const status = c.res.status;
    const auth = c.var.auth;
    // 提取错误码（errorResponse 写入 body.error.code）
    let errorCode: string | null = null;
    try {
      // 不消费 body（clone 后异步读，避免阻塞响应返回）
      const clone = c.res.clone();
      const body = (await clone.json().catch(() => null)) as { error?: { code?: string } } | null;
      errorCode = body?.error?.code ?? null;
    } catch {
      // 流式响应 / 非 JSON → 无错误码
    }

    // fire-and-forget 写日志（不 await，避免拖慢响应）
    void writeRequestLog(db, {
      requestId,
      userId: auth?.userId ?? null,
      apiKeyId: auth?.apiKeyId ?? null,
      method: c.req.method,
      path,
      statusCode: status,
      errorCode,
      durationMs,
      attempts: 1, // 候选循环次数在路由内，中间件层不可见；P1 通过 c.var 传递
    }, logger);
  };
}

/** 截断请求摘要的便捷导出（路由内构造 candidatesTried 时用） */
export { truncateSummary };
