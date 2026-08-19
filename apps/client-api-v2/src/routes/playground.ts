/**
 * 操练场代理路由：POST /v1/playground/chat/completions（会话守护）。
 * 每请求替用户现签 5 分钟网关 JWT（typ playground 独立低限额）→ 代理到网关
 * /v1/chat/completions，SSE 字节流原样回传；计费走正常管线（用户余额）。
 * 请求体收敛到 chat 白名单字段（网关侧还有二道收敛）。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { signPlaygroundJwt } from '../domain/playground.js';
import { userCtxOf } from './ctx.js';
import type { SessionEnv } from '../middleware/session.js';

const bodySchema = z.object({
  model: z.string().min(1).max(64),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string().max(64_000),
      }),
    )
    .min(1)
    .max(50),
  stream: z.literal(true).optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().max(16_384).optional(),
});

export function playgroundRoutes(
  opts: { gatewayUrl: string; gatewayJwtSecret: string; userStatus: (userId: number) => Promise<boolean> },
  session: MiddlewareHandler<SessionEnv>,
) {
  const app = new Hono<SessionEnv>();

  app.post('/v1/playground/chat/completions', session, async (c) => {
    void userCtxOf(c);
    const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { error: { code: 'invalid_request', message: parsed.error.issues[0]?.message ?? '参数非法' } },
        400,
      );
    }
    const userId = c.get('userId');
    if (!(await opts.userStatus(userId))) {
      return c.json({ error: { code: 'user_disabled', message: '账户不可用' } }, 403);
    }
    const token = await signPlaygroundJwt(userId, opts.gatewayJwtSecret);
    const upstream = await fetch(`${opts.gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...parsed.data, stream: true }),
      signal: c.req.raw.signal, // 客户端断开联动取消
    }).catch(() => null);
    if (!upstream) {
      return c.json({ error: { code: 'playground_unavailable', message: '推理服务暂不可用' } }, 503);
    }
    if (!upstream.ok || !upstream.body) {
      // 错误体白名单转发：只认 {error:{code,message}} 信封（网关已脱敏）；其余一律
      // 折叠成通用文案——上游原文（内部模型名/渠道细节/中间层报文）不透给终端用户
      const text = await upstream.text().catch(() => '');
      const PASS_STATUS = new Set([400, 401, 402, 403, 404, 429, 500, 502, 503, 504]);
      const status = PASS_STATUS.has(upstream.status) ? (upstream.status as 400 | 401 | 402 | 403 | 404 | 429 | 500 | 502 | 503 | 504) : 502;
      let envelope: { code: string; message: string } = {
        code: 'playground_upstream_error',
        message: '推理服务暂时不可用，请稍后重试',
      };
      try {
        const upstreamJson = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
        if (upstreamJson?.error && typeof upstreamJson.error.code === 'string' && typeof upstreamJson.error.message === 'string') {
          envelope = { code: upstreamJson.error.code.slice(0, 64), message: upstreamJson.error.message.slice(0, 300) };
        }
      } catch {
        /* 非 JSON → 通用信封 */
      }
      return c.json({ error: envelope }, status);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
  });

  return app;
}
