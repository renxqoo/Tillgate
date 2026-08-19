/**
 * 路由层 RunContext 派生：会话已注入 adminId（session 中间件先行），此处只是
 * 「HTTP 请求 → 用例上下文」的形状转换——不放业务参数。
 */
import type { Context } from 'hono';
import type { RunContext } from '@ai-gateway/service';
import type { SessionEnv } from '../middleware/session.js';

export function adminCtxOf(c: Context<SessionEnv>): RunContext {
  return {
    requestId: c.get('requestId'),
    actor: { kind: 'admin', id: c.get('adminId') },
    traceParent: null,
  };
}
