import { Hono } from 'hono';
import { z } from 'zod';
import type { Endpoint } from '@ai-gateway/ai';
import type { AuthEnv } from '../middleware/auth.js';
import { jsonBody } from '../lib/validation.js';
import type { RunInference } from '../services/pipeline/run.js';

/**
 * 推理端点注册表（下游单一真相）：path / kind / schema 一处定义，
 * app.ts 的鉴权挂载与路由注册都由本表驱动——加端点 = 表里加一行 + schema。
 * （例：/v1/responses = 新增一行 + responses↔chat 翻译层，不再改 app.ts 的两串硬编码。）
 *
 * model 字段约束（两 schema 共享）：
 * - ≤64 对齐 external_name varchar(64)：超长/NUL 名不得进路由缓存键
 *   （route:mapping:v*:{name} 16MB 放大）与 404 回显；
 * - messages/input 条数上界防 JSON.parse 内存放大（实测 16MB 结构体 ≈2.5-7 倍瞬时堆）。
 */
const modelField = z
  .string()
  .min(1, 'model 不能为空')
  .max(64)
  .refine((v) => !v.includes('\0'), { message: 'model 含非法字符' });

/** chat/completions schema（必需字段校验，未知参数透传） */
const chatSchema = z
  .object({
    model: modelField,
    messages: z.array(z.unknown()).min(1, 'messages 不能为空').max(1000),
    stream: z.boolean().optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    n: z.number().int().positive().max(16).optional(),
  })
  .passthrough();

/**
 * embeddings schema（BUG-F，new-api #2463/#2443 同类修复后）：
 * - 官方形态全收：string / string[] / number[]（token 数组）/ number[][]（token 批）
 * - 多模态结构化形态（豆包/千问 VL 等 OpenAI 兼容生态）按未知对象透传
 * - 仅保留数量上界（≤2048，对齐 OpenAI 批量上界）防 JSON.parse 内存放大——
 *   结构不做白名单（与未知参数 passthrough 哲学一致）
 */
const embedInputItem = z.union([
  z.string(),
  z.number(),
  z.array(z.number()),
  z.record(z.string(), z.unknown()),
]);
const embedSchema = z
  .object({
    model: modelField,
    input: z.union([z.string(), z.array(embedInputItem).max(2048)]),
  })
  .passthrough();

/** 推理端点描述（注册表项） */
export interface InferenceEndpoint {
  /** 对外路径（OpenAI 兼容面） */
  path: string;
  /** 管线端点类型（决定 adapter 上游寻址与流式判定） */
  kind: Endpoint;
  schema: z.ZodType<Record<string, unknown>>;
}

/**
 * 推理端点表（api-contract §2.1 chat / §2.5 embeddings）。
 * 顺序即注册顺序；鉴权中间件与路由挂载均遍历本表。
 */
export const inferenceEndpoints: readonly InferenceEndpoint[] = [
  { path: '/v1/chat/completions', kind: 'chat', schema: chatSchema },
  { path: '/v1/embeddings', kind: 'embeddings', schema: embedSchema },
];

/**
 * 推理路由工厂（表项驱动）：schema 校验 + 委托管线。
 * 管线承载全部业务编排（限流/预扣/候选循环/计量），路由保持薄。
 */
export function inferenceRoutes(
  runInference: RunInference,
  endpoint: InferenceEndpoint,
): Hono<AuthEnv> {
  return new Hono<AuthEnv>().post('/', jsonBody(endpoint.schema), async (c) => {
    const body = c.req.valid('json') as Record<string, unknown>;
    return runInference(c, endpoint.kind, body);
  });
}
