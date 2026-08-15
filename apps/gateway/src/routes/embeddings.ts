import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../middleware/auth.js';
import { jsonBody } from '../lib/validation.js';
import type { LlmPipeline } from '../services/pipeline/llm-pipeline.js';

/** embeddings 请求 schema（input 数组 ≤2048，对齐 OpenAI 批量上界，防内存放大） */
const embedSchema = z
  .object({
    model: z.string().min(1, 'model 不能为空').max(64).refine((v) => !v.includes('\0'), {
      message: 'model 含非法字符',
    }),
    input: z.union([z.string(), z.array(z.string()).max(2048)]),
  })
  .passthrough();

/**
 * POST /v1/embeddings — 向量化（OpenAI 标准，api-contract §2.5）。
 * 与 chat 共用管线（限流/预扣/候选循环/计量），差异由 kind 参数化（非流式、无 fallback 模型）。
 */
export function embeddingsRoutes(pipeline: LlmPipeline): Hono<AuthEnv> {
  return new Hono<AuthEnv>().post('/', jsonBody(embedSchema), async (c) => {
    const body = c.req.valid('json') as Record<string, unknown>;
    return pipeline.run(c, 'embeddings', body);
  });
}
