/**
 * /v1/* 请求日志（鉴权前挂载：401/429 也入日志——语义是「记录一切 /v1 请求」）。
 * 非资金事实；写失败只记日志不阻塞请求（观测不能反噬可用性）。
 * 来源 IP：直连 socket + 信任代理头（客户端可伪造的头一律不采信）。
 * 响应体嗅探只对 JSON 做——clone() 会把整条 SSE 流在内存里再走一遍（放大）。
 */
import type { MiddlewareHandler } from 'hono';
import { createRepositories, type Db, type Repositories } from '@ai-gateway/repository';
import { readOnly, systemContext } from '@ai-gateway/service';
import { socketAddressFromContext, trustedClientIp } from '@ai-gateway/http';
import type { AuthEnv } from './api-key.js';

export function requestLogMiddleware(
  deps: { db: Db; repos?: Repositories; trustedProxyHops?: number },
): MiddlewareHandler<AuthEnv> {
  const repos = deps.repos ?? createRepositories();
  return async (c, next) => {
    const startedAt = Date.now();
    const requestId = c.get('requestId') ?? crypto.randomUUID(); // 服务端生成（requestId 中间件先挂载）
    await next();
    const durationMs = Date.now() - startedAt;
    const auth = c.get('auth');
    let errorCode: string | null = null;
    const contentType = c.res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      try {
        const body = (await c.res.clone().json()) as { error?: { code?: string } };
        errorCode = body.error?.code ?? null;
      } catch {
        errorCode = null;
      }
    }
    const sourceIp = trustedClientIp({
      headers: c.req.raw.headers,
      trustedProxyHops: deps.trustedProxyHops ?? 0,
      socketAddress: socketAddressFromContext(c),
    });
    try {
      await repos.usageLog.insertRequestLog(readOnly(systemContext('request-log'), deps.db), {
        requestId,
        userId: auth?.userId ?? null,
        apiKeyId: auth?.apiKeyId ?? null,
        method: c.req.method,
        path: c.req.path,
        statusCode: c.res.status,
        errorCode,
        durationMs,
        requestSummary: null,
        sourceIp,
      });
    } catch (error) {
      console.error('[request-log] write failed:', error);
    }
  };
}
