/**
 * 推理端点契约（v1 routes/inference-endpoints.ts 的 schema/端点表段迁移）：
 * 文本族 chat/completions（规范形）+ embeddings + completions/responses/messages
 * （外部协议经 codec 在路由边界翻译为规范形——管线内部恒规范形）+ 模态 JSON 族。
 * codec 翻译函数单一真相在 @tokenlens/ai protocol（§3.6 透传例外 1）。
 */
import { z } from 'zod';
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
} from '@tokenlens/inference';

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

export const modelField = z
  .string()
  .min(1, 'model must not be empty')
  .max(64)
  .refine((v) => !v.includes('\0'), 'model contains invalid characters');

const chatSchema = z
  .object({
    model: modelField,
    messages: z.array(z.unknown()).min(1).max(1000),
    stream: z.boolean().optional(),
    /** 输出预算参数校验（负数/非整数不得流向上游与预扣口径） */
    max_tokens: z.number().int().positive().max(1_000_000).optional(),
    max_completion_tokens: z.number().int().positive().max(1_000_000).optional(),
    n: z.number().int().positive().max(16).optional(),
  })
  .passthrough();

const embedSchema = z
  .object({
    model: modelField,
    input: z.union([z.string(), z.array(z.unknown()).max(2048)]),
  })
  .passthrough();

const completionsSchema = z
  .object({
    model: modelField,
    prompt: z.union([z.string(), z.array(z.unknown())]),
    stream: z.boolean().optional(),
  })
  .passthrough();

const responsesSchema = z
  .object({
    model: modelField,
    input: z.union([z.string(), z.array(z.unknown()).max(1000)]).optional(),
    instructions: z.string().optional(),
    stream: z.boolean().optional(),
    max_output_tokens: z.number().int().positive().optional(),
  })
  .passthrough();

const claudeMessagesSchema = z
  .object({
    model: modelField,
    messages: z.array(z.unknown()).min(1).max(1000),
    max_tokens: z.number().int().positive().optional(),
    stream: z.boolean().optional(),
  })
  .passthrough();

const imagesSchema = z
  .object({
    model: modelField,
    prompt: z.string().min(1).max(32000),
    n: z.number().int().positive().max(16).optional(),
    size: z.string().max(32).optional(),
  })
  .passthrough();

const audioSpeechSchema = z
  .object({
    model: modelField,
    input: z.string().min(1).max(8192),
    voice: z.string().min(1).max(64),
  })
  .passthrough();

const rerankSchema = z
  .object({
    model: modelField,
    query: z.string().min(1).max(32000),
    documents: z.array(z.unknown()).min(1).max(2048),
  })
  .passthrough();

const moderationsSchema = z
  .object({
    model: modelField,
    input: z.union([z.string(), z.array(z.unknown())]),
  })
  .passthrough();

export interface InferenceEndpoint {
  path: string;
  /** 调用端点（ai 包 Endpoint 词表——单一真相，路由边界显式声明进管线） */
  kind: Endpoint;
  schema: z.ZodType<Record<string, unknown>>;
  codec?: InboundCodec;
}

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
