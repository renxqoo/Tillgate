import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@ai-gateway/db';
import { users } from '@ai-gateway/db/schema';
import type { ClientEnv } from '@ai-gateway/identity';

import { signPlaygroundJwt } from '../services/playground-jwt.js';

/**
 * POST /api/playground/chat/completions —— 控制台操练场代理（会话 + CSRF 由挂载方守护）：
 * 每请求替用户现签 5 分钟网关 JWT（独立低限额）→ 代理到网关 /v1/chat/completions，
 * SSE 字节流原样回传。计费走正常管线（用户余额），请求体收敛到 chat 白名单字段。
 */

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
  db: Db,
  opts: { gatewayUrl: string; gatewayJwtSecret: string },
): Hono<ClientEnv> {
  return new Hono<ClientEnv>().post('/chat/completions', async (c) => {
    const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: 'invalid_request', message: parsed.error.issues[0]?.message ?? '参数非法' } }, 400);
    }
    const user = await db.query.users.findFirst({
      where: eq(users.id, c.var.session.userId),
      columns: { rateCardId: true, status: true },
    });
    if (!user || user.status !== 0) {
      return c.json({ error: { code: 'user_disabled', message: '账户不可用' } }, 403);
    }
    const token = await signPlaygroundJwt(c.var.session.userId, opts.gatewayJwtSecret, user.rateCardId);
    const upstream = await fetch(`${opts.gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        // 网关 requestId 由网关自生成；取消联动客户端断开
      },
      body: JSON.stringify({ ...parsed.data, stream: true }),
      signal: c.req.raw.signal,
    }).catch(() => null);
    if (!upstream) {
      return c.json({ error: { code: 'playground_unavailable', message: '推理服务暂不可用' } }, 503);
    }
    // 非 2xx：错误信封 JSON 直传（OpenAI 风格）
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '');
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = { error: { code: 'playground_upstream_error', message: `上游 ${upstream.status}` } };
      }
      return c.json(json, upstream.status as 400 | 401 | 402 | 403 | 429 | 500 | 503);
    }
    // SSE 原样回传
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
  });
}
