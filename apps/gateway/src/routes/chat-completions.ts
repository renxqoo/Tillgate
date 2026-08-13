import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../middleware/auth.js';
import { jsonBody } from '../lib/validation.js';
import type { LlmPipeline } from '../services/pipeline/llm-pipeline.js';

/** chat/completions 请求 schema（必需字段校验，未知参数透传） */
const chatSchema = z
  .object({
    model: z.string().min(1, 'model 不能为空'),
    messages: z.array(z.unknown()).min(1, 'messages 不能为空'),
    stream: z.boolean().optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    n: z.number().int().positive().max(16).optional(),
  })
  .passthrough();

/**
 * POST /v1/chat/completions — 对话补全（OpenAI 格式，含 SSE 流式）。
 * 路由只做 schema 校验 + 委托管线（管线承载全部业务编排）。
 */
export function chatCompletionsRoutes(pipeline: LlmPipeline): Hono<AuthEnv> {
  return new Hono<AuthEnv>().post('/', jsonBody(chatSchema), async (c) => {
    const body = c.req.valid('json') as Record<string, unknown>;
    return pipeline.run(c, 'chat', body);
  });
}
