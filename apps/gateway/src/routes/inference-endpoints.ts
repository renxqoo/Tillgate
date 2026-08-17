import { Hono } from 'hono';
import { z } from 'zod';
import type { Endpoint } from '@ai-gateway/ai';
import type { AuthEnv } from '../middleware/auth.js';
import { jsonBody } from '../lib/validation.js';
import type { RunInference } from '../services/pipeline/run.js';
import {
  claudeMessagesCodec,
  completionsCodec,
  encodeResponseForClient,
  responsesCodec,
  type InboundCodec,
} from '../services/protocol-codecs.js';

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

/** legacy completions schema（prompt → chat 单向翻译） */
const completionsSchema = z
  .object({
    model: modelField,
    prompt: z.union([z.string(), z.array(z.union([z.string(), z.array(z.number())]))]),
    stream: z.boolean().optional(),
  })
  .passthrough();

/** responses schema（input/instructions → chat 翻译） */
const responsesSchema = z
  .object({
    model: modelField,
    input: z.union([z.string(), z.array(z.unknown()).max(1000)]).optional(),
    instructions: z.string().optional(),
    stream: z.boolean().optional(),
    max_output_tokens: z.number().int().positive().optional(),
  })
  .passthrough();

/** claude messages schema（messages 必填；max_tokens 由 codec 默认补齐） */
const claudeMessagesSchema = z
  .object({
    model: modelField,
    messages: z.array(z.unknown()).min(1).max(1000),
    max_tokens: z.number().int().positive().optional(),
    stream: z.boolean().optional(),
  })
  .passthrough();

/** 推理端点描述（注册表项） */
export interface InferenceEndpoint {
  /** 对外路径（OpenAI 兼容面 + 原生协议端点） */
  path: string;
  /** 管线端点类型（决定 adapter 上游寻址与流式判定） */
  kind: Endpoint;
  schema: z.ZodType<Record<string, unknown>>;
  /** 外部协议 codec（可选）：缺省 = 请求/响应已是规范形，直接透传 */
  codec?: InboundCodec;
}

/**
 * 推理端点表（api-contract §2）。顺序即注册顺序；鉴权中间件与路由挂载均遍历本表。
 * 外部协议端点（claude messages / responses / completions）经 codec 在路由边界
 * 翻译为规范形后走 chat 管线（管线内部恒为规范形，单一真相）。
 */
/** 视频生成提交 schema（new-api 形状：/v1/video/generations） */
const videoSchema = z
  .object({
    model: modelField,
    prompt: z.string().min(1, 'prompt 不能为空').max(8_000),
    /** 秒（4-15，缺省 6）——按秒计费口径的结算快照与预扣上界 */
    duration: z.number().int().min(4).max(15).optional(),
    /** 尺寸串（"1280x720"）→ MiniMax resolution 档位 */
    size: z.string().max(32).optional(),
    /** 首帧图（URL / data URI） */
    image: z.string().max(1_000_000).optional(),
    /** 尾帧图（与 image 成对） */
    last_frame_image: z.string().max(1_000_000).optional(),
  })
  .passthrough();

/** 音乐生成提交 schema（/v1/music/generations） */
const musicSchema = z
  .object({
    model: modelField,
    prompt: z.string().min(1, 'prompt 不能为空').max(4_000),
    lyrics: z.string().max(20_000).optional(),
  })
  .passthrough();

export const inferenceEndpoints: readonly InferenceEndpoint[] = [
  { path: '/v1/chat/completions', kind: 'chat', schema: chatSchema },
  { path: '/v1/embeddings', kind: 'embeddings', schema: embedSchema },
  { path: '/v1/completions', kind: 'chat', schema: completionsSchema, codec: completionsCodec },
  { path: '/v1/responses', kind: 'chat', schema: responsesSchema, codec: responsesCodec },
  { path: '/v1/messages', kind: 'chat', schema: claudeMessagesSchema, codec: claudeMessagesCodec },
  { path: '/v1/video/generations', kind: 'video', schema: videoSchema },
  { path: '/v1/music/generations', kind: 'music', schema: musicSchema },
];

/**
 * 推理路由工厂（表项驱动）：schema 校验 + 委托管线。
 * 管线承载全部业务编排（限流/预扣/候选循环/计量），路由保持薄。
 * codec 端点：外部体 → 规范形 → 管线 → 响应按外部线格式编码。
 */
export function inferenceRoutes(
  runInference: RunInference,
  endpoint: InferenceEndpoint,
): Hono<AuthEnv> {
  return new Hono<AuthEnv>().post('/', jsonBody(endpoint.schema), async (c) => {
    const body = c.req.valid('json') as Record<string, unknown>;
    if (!endpoint.codec) {
      return runInference(c, endpoint.kind, body);
    }
    const model = typeof body.model === 'string' ? body.model : '';
    const canonical = endpoint.codec.decodeRequest(body, model);
    const response = await runInference(c, endpoint.kind, canonical);
    return encodeResponseForClient(response, endpoint.codec, canonical.model as string);
  });
}
