import { requestLogs } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import type { Logger } from '@ai-gateway/core';

/**
 * 请求日志写入（data-model §3.13 / requirements 4.10）。
 *
 * 与 usage_logs 分工：
 *   - usage_logs = 计费账本（每成功请求一条，含费用快照）
 *   - request_logs = 排障日志（每个请求一条，含状态码/错误码/耗时），30 天滚动
 *
 * fire-and-forget 写入，失败仅记日志（不阻塞响应、不影响计费链路）。
 */

export interface RequestLogInput {
  requestId: string;
  userId?: number | null;
  apiKeyId?: number | null;
  method: string;
  path: string;
  statusCode: number;
  errorCode?: string | null;
  durationMs: number;
  /** 请求摘要（截断，不含敏感内容） */
  requestSummary?: unknown | null;
}

/**
 * 写一条请求日志（fire-and-forget，失败不抛）。
 * 调用方用 `.catch(() => {})` 或不 await，确保不阻塞主流程。
 */
export async function writeRequestLog(
  db: Db,
  input: RequestLogInput,
  logger?: Logger,
): Promise<void> {
  try {
    await db.insert(requestLogs).values({
      requestId: input.requestId,
      userId: input.userId ?? null,
      apiKeyId: input.apiKeyId ?? null,
      method: input.method,
      path: input.path,
      statusCode: input.statusCode,
      errorCode: input.errorCode ?? null,
      durationMs: input.durationMs,
      attempts: 1,
      requestSummary: (input.requestSummary as never) ?? null,
    });
  } catch (err) {
    // 写失败不阻塞主流程（计费链路独立）；仅记日志便于运维排查
    logger?.warn(
      { requestId: input.requestId, err: (err as Error).message },
      'request_log write failed',
    );
  }
}

/** 截断请求摘要（防超大 jsonb 拖垮 DB，默认 2000 字符，requirements 4.10） */
export function truncateSummary(obj: unknown, maxChars = 2000): unknown {
  if (obj == null) return null;
  try {
    const s = JSON.stringify(obj);
    if (s.length <= maxChars) return obj;
    return { truncated: true, preview: s.slice(0, maxChars), totalLength: s.length };
  } catch {
    return null;
  }
}
