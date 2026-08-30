/**
 * 推理端点契约：
 * 文本族 chat/completions（规范形）+ embeddings + completions/responses/messages
 * （外部协议经 codec 在路由边界翻译为规范形——管线内部恒规范形）+ 模态 JSON 族。
 * codec 翻译函数单一真相在 @tillgate/ai protocol。
 */
import * as z from 'zod';
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
} from '@tillgate/inference';

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

/**
 * responses 面显式 400 校验族（无法兑现/无法映射的语义不静默丢弃——每条拒绝
 * 都有明确 message；store 恒不生效（等价 store:false，响应全量返回），不视为错）。
 * 逐项拆模块级纯函数：superRefine 只做编排（complexity/行数门禁）。
 */
type RefineCtx = z.RefinementCtx;

/** 状态性参数：previous_response_id（任何非 undefined 值含 null）与 background:true */
function rejectStatefulParams(v: Record<string, unknown>, ctx: RefineCtx): void {
  if (v.previous_response_id !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['previous_response_id'],
      message: 'previous_response_id is not supported: gateway is stateless',
    });
  }
  if (v.background === true) {
    ctx.addIssue({
      code: 'custom',
      path: ['background'],
      message: 'background mode is not supported: gateway responds synchronously only',
    });
  }
}

/** 工具面：宿主侧工具（web_search 等网关无法兑现）与缺名 function 工具 */
function rejectUnsupportedTools(v: Record<string, unknown>, ctx: RefineCtx): void {
  if (!Array.isArray(v.tools)) return;
  for (const raw of v.tools) {
    if (typeof raw !== 'object' || raw === null) continue;
    const tool = raw as { type?: unknown; name?: unknown };
    if (tool.type !== 'function') {
      ctx.addIssue({
        code: 'custom',
        path: ['tools'],
        message: `tool type '${String(tool.type).slice(0, 32)}' is not supported: only function tools can be forwarded`,
      });
      return;
    }
    if (typeof tool.name !== 'string' || tool.name.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['tools'],
        message: 'function tool requires a non-empty name',
      });
      return;
    }
  }
}

/** tool_choice 只认可可映射形态——未知形态静默丢弃会把「受限调用」漂移成「随意调用」 */
function rejectUnsupportedToolChoice(v: Record<string, unknown>, ctx: RefineCtx): void {
  const tc = v.tool_choice;
  if (tc === undefined) return;
  const mappable =
    tc === 'auto' ||
    tc === 'none' ||
    tc === 'required' ||
    (typeof tc === 'object' &&
      tc !== null &&
      (tc as { type?: unknown }).type === 'function' &&
      typeof (tc as { name?: unknown }).name === 'string' &&
      ((tc as { name?: unknown }).name as string).length > 0);
  if (!mappable) {
    ctx.addIssue({
      code: 'custom',
      path: ['tool_choice'],
      message:
        'unsupported tool_choice form: expected auto | none | required | {type:function,name}',
    });
  }
}

/** text.format 只认可可映射类型（text/json_object/json_schema） */
function rejectUnsupportedTextFormat(v: Record<string, unknown>, ctx: RefineCtx): void {
  const { text } = v;
  if (typeof text !== 'object' || text === null) return;
  const { format } = text as { format?: unknown };
  if (format === undefined) return;
  const type =
    typeof format === 'object' && format !== null ? (format as { type?: unknown }).type : undefined;
  if (type !== 'text' && type !== 'json_object' && type !== 'json_schema') {
    ctx.addIssue({
      code: 'custom',
      path: ['text.format'],
      message: 'unsupported text.format type: expected text | json_object | json_schema',
    });
  }
}

const responsesSchema = z
  .object({
    model: modelField,
    input: z.union([z.string(), z.array(z.unknown()).max(1000)]).optional(),
    instructions: z.string().optional(),
    stream: z.boolean().optional(),
    max_output_tokens: z.number().int().positive().optional(),
  })
  .passthrough()
  .superRefine((v, ctx) => {
    rejectStatefulParams(v, ctx);
    rejectUnsupportedTools(v, ctx);
    rejectUnsupportedToolChoice(v, ctx);
    rejectUnsupportedTextFormat(v, ctx);
  });

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
