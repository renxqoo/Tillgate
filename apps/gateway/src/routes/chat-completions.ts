import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../middleware/auth.js';
import { jsonBody } from '../lib/validation.js';
import type { LlmPipeline } from '../services/pipeline/llm-pipeline.js';

/**
 * chat/completions 请求 schema（必需字段校验，未知参数透传）。
 * model ≤64 对齐 external_name varchar(64)：超长/NUL 名不得进路由缓存键
 * （route:mapping:v*:{name} 16MB 放大）与 404 回显；messages/tools 条数上界
 * 防 JSON.parse 内存放大（实测 16MB 结构体 ≈2.5-7 倍瞬时堆）。
 */
const chatSchema = z
  .object({
    model: z.string().min(1, 'model 不能为空').max(64).refine((v) => !v.includes('\0'), {
      message: 'model 含非法字符',
    }),
    messages: z.array(z.unknown()).min(1, 'messages 不能为空').max(1000),
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
