/**
 * 推理端点表 + 端点路由（表项驱动挂载——api-contract 单一真相）。
 *
 *   文本族：chat/completions（规范形）+ embeddings（输出恒 0）+ completions/responses/
 *   messages（外部协议经 codec 在路由边界翻译为规范形——管线内部恒规范形）
 *   任务族（video/music）：提交即 201 + 任务查询——依赖 generation_tasks 子系统（G5b）。
 * codec 翻译函数单一真相在 packages/ai/protocol；错误信封恒 OpenAI 风格（SDK 按 HTTP 状态判定）。
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  canonicalStreamToClaudeStream,
  canonicalStreamToCompletionsStream,
  canonicalStreamToResponsesStream,
  chatResponseToClaude,
  chatResponseToCompletions,
  chatResponseToResponses,
  claudeRequestToChat,
  completionsRequestToChat,
  responsesRequestToChat,
  type Endpoint,
} from '@ai-gateway/ai';
import type { AuthEnv } from '../middleware/api-key.js';
import type { createRunChat } from '../pipeline/run-chat.js';
import type { ChatCompletionBody, ChatResponse } from '../pipeline/run-chat.js';

type RunChat = ReturnType<typeof createRunChat>;

export interface InboundCodec {
  decodeRequest(body: Record<string, unknown>, model: string): Record<string, unknown>;
  encodeResponse(body: unknown): unknown;
  encodeStream(stream: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array>;
}

export const completionsCodec: InboundCodec = {
  decodeRequest: (body) => completionsRequestToChat(body) as Record<string, unknown>,
  encodeResponse: (body) => chatResponseToCompletions(body),
  encodeStream: (stream) => canonicalStreamToCompletionsStream(stream),
};
export const responsesCodec: InboundCodec = {
  decodeRequest: (body) => responsesRequestToChat(body) as Record<string, unknown>,
  encodeResponse: (body) => chatResponseToResponses(body),
  encodeStream: (stream) => canonicalStreamToResponsesStream(stream),
};
export const claudeMessagesCodec: InboundCodec = {
  decodeRequest: (body) => claudeRequestToChat(body) as Record<string, unknown>,
  encodeResponse: (body) => chatResponseToClaude(body),
  encodeStream: (stream, model) => canonicalStreamToClaudeStream(stream, model),
};

const modelField = z.string().min(1, 'model must not be empty').max(64).refine((v) => !v.includes('\0'), 'model contains invalid characters');

const chatSchema = z.object({
  model: modelField,
  messages: z.array(z.unknown()).min(1).max(1000),
  stream: z.boolean().optional(),
  /** 输出预算参数校验（负数/非整数不得流向上游与预扣口径） */
  max_tokens: z.number().int().positive().max(1_000_000).optional(),
  max_completion_tokens: z.number().int().positive().max(1_000_000).optional(),
  n: z.number().int().positive().max(16).optional(),
}).passthrough();

const embedSchema = z.object({
  model: modelField,
  input: z.union([z.string(), z.array(z.unknown()).max(2048)]),
}).passthrough();

const completionsSchema = z.object({
  model: modelField,
  prompt: z.union([z.string(), z.array(z.unknown())]),
  stream: z.boolean().optional(),
}).passthrough();

const responsesSchema = z.object({
  model: modelField,
  input: z.union([z.string(), z.array(z.unknown()).max(1000)]).optional(),
  instructions: z.string().optional(),
  stream: z.boolean().optional(),
  max_output_tokens: z.number().int().positive().optional(),
}).passthrough();

const claudeMessagesSchema = z.object({
  model: modelField,
  messages: z.array(z.unknown()).min(1).max(1000),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
}).passthrough();

export type InferenceEndpoint = {
  path: string;
  /** 调用端点（ai 包 Endpoint 词表——单一真相，路由边界显式声明进管线） */
  kind: Endpoint;
  schema: z.ZodType<Record<string, unknown>>;
  codec?: InboundCodec;
};

const imagesSchema = z.object({
  model: modelField,
  prompt: z.string().min(1).max(32000),
  n: z.number().int().positive().max(16).optional(),
  size: z.string().max(32).optional(),
}).passthrough();

const audioSpeechSchema = z.object({
  model: modelField,
  input: z.string().min(1).max(8192),
  voice: z.string().min(1).max(64),
}).passthrough();

const rerankSchema = z.object({
  model: modelField,
  query: z.string().min(1).max(32000),
  documents: z.array(z.unknown()).min(1).max(2048),
}).passthrough();

const moderationsSchema = z.object({
  model: modelField,
  input: z.union([z.string(), z.array(z.unknown())]),
}).passthrough();

export const inferenceEndpoints: readonly InferenceEndpoint[] = [
  { path: '/v1/chat/completions', kind: 'chat', schema: chatSchema },
  { path: '/v1/embeddings', kind: 'embeddings', schema: embedSchema },
  { path: '/v1/completions', kind: 'chat', schema: completionsSchema, codec: completionsCodec },
  { path: '/v1/responses', kind: 'chat', schema: responsesSchema, codec: responsesCodec },
  { path: '/v1/messages', kind: 'chat', schema: claudeMessagesSchema, codec: claudeMessagesCodec },
  { path: '/v1/images/generations', kind: 'images', schema: imagesSchema },
  { path: '/v1/audio/speech', kind: 'audio_speech', schema: audioSpeechSchema },
  { path: '/v1/rerank', kind: 'rerank', schema: rerankSchema },
  { path: '/v1/moderations', kind: 'moderations', schema: moderationsSchema },
];

/** 端点路由：schema 校验 →（codec 端点先 decode）→ 管线 → 响应按外部线格式编码 */
/**
 * OpenAI legacy 引擎别名路由（pre-1.0 SDK 的 /v1/engines/:model/embeddings）。
 * 路径段模型名注入 body.model 后走端点同一管线（鉴权/计费/计量完全一致）。
 */
export function enginesAliasRoutes(runChat: RunChat, endpoint: InferenceEndpoint): Hono<AuthEnv> {
  // 挂载路径已带 :model 参数段（app.route('/v1/engines/:model', …)——param 全程可见）
  return new Hono<AuthEnv>().post('/embeddings', async (c) => {
    const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const model = c.req.param('model');
    const merged = { ...raw, model };
    const parsed = endpoint.schema.safeParse(merged);
    if (!parsed.success) {
      return c.json(
        { error: { code: 'invalid_body', message: parsed.error.issues[0]?.message ?? 'invalid request body' } },
        400,
      );
    }
    const auth = c.get('auth');
    const externalModel = (parsed.data as { model: string }).model;
    const body = parsed.data as unknown as ChatCompletionBody;
    body.stream = false;
    const result = await runChat(auth.ctx, { userId: auth.userId, apiKeyId: auth.apiKeyId, appId: auth.appId, allowedModels: auth.allowedModels ?? null, rpmLimit: auth.rpmLimit, tpmLimit: auth.tpmLimit, userRpmLimit: auth.userRpmLimit, userTpmLimit: auth.userTpmLimit }, body, endpoint.kind);
    return encodeResult(c, result, endpoint, externalModel);
  });
}

export function inferenceRoutes(runChat: RunChat, endpoint: InferenceEndpoint): Hono<AuthEnv> {
  return new Hono<AuthEnv>().post('/', async (c) => {
    const raw = (await c.req.json().catch(() => null)) as unknown;
    const parsed = endpoint.schema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: { code: 'invalid_body', message: parsed.error.issues[0]?.message ?? 'invalid request body' } },
        400,
      );
    }
    const auth = c.get('auth');
    const externalModel = (parsed.data as { model: string }).model;
    // codec 端点：外部体 → 规范形（估算/计费/上游全用规范形）
    const canonical = endpoint.codec
      ? endpoint.codec.decodeRequest(parsed.data, externalModel)
      : parsed.data;
    const body = canonical as unknown as ChatCompletionBody;
    if (endpoint.kind !== 'chat' && endpoint.codec === undefined) {
      body.stream = false; // 非规范形 chat 的端点族无流式（embeddings/模态 JSON 族）
    }
    const result = await runChat(auth.ctx, { userId: auth.userId, apiKeyId: auth.apiKeyId, appId: auth.appId, allowedModels: auth.allowedModels ?? null, rpmLimit: auth.rpmLimit, tpmLimit: auth.tpmLimit, userRpmLimit: auth.userRpmLimit, userTpmLimit: auth.userTpmLimit }, body, endpoint.kind);
    return encodeResult(c, result, endpoint, externalModel);
  });
}

async function encodeResult(
  c: { json: (body: unknown, status?: ContentfulStatusCode) => Response } & { get: (key: 'requestId') => string | undefined },
  result: ChatResponse,
  endpoint: InferenceEndpoint,
  model: string,
): Promise<Response> {
  const codec = endpoint.codec;
  if ('stream' in result) {
    const body = codec ? codec.encodeStream(result.stream, model) : result.stream;
    // x-request-id 显式带上：raw Response 不走 Hono 的 c.header 合并路径，
    // 缺它则流式客户端无法把账单/日志与本响应对齐（非流式 c.json 自动带）
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        // nginx 反代默认 proxy_buffering on 会缓冲整条 SSE（首字节到达前攒满缓冲）——
        // 显式关闭（生产 nginx 前置时不设会隐形卡流）
        'x-accel-buffering': 'no',
        'x-request-id': c.get('requestId') ?? '',
      },
    });
  }
  if ('rawBody' in result) {
    return new Response(result.rawBody, {
      status: 200,
      headers: {
        'content-type': result.rawContentType,
        'x-request-id': c.get('requestId') ?? '',
      },
    });
  }
  if (codec && result.status === 200) {
    return c.json(codec.encodeResponse(result.body) as Record<string, unknown>);
  }
  return c.json(result.body, result.status as ContentfulStatusCode);
}
