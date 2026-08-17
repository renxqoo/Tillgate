import {
  claudeRequestToChat,
  chatResponseToClaude,
  canonicalStreamToClaudeStream,
  geminiRequestToChat,
  chatResponseToGemini,
  canonicalStreamToGeminiStream,
  responsesRequestToChat,
  chatResponseToResponses,
  canonicalStreamToResponsesStream,
  completionsRequestToChat,
  chatResponseToCompletions,
  canonicalStreamToCompletionsStream,
} from '@ai-gateway/ai';

/**
 * 入站协议 codec 桥接（路由层 ↔ 规范形管线）。
 *
 * 管线内部恒为规范形（OpenAI chat 线格式）——外部协议在路由边界双向翻译：
 *   decodeRequest：外部请求体 → 规范形（管线/计费/估算全部用规范形）
 *   encodeResponse：规范形非流式响应 → 外部形
 *   encodeStream：规范形 SSE 字节流 → 外部线格式字节流
 * 翻译函数单一真相在 packages/ai/src/protocol/（上游适配器与入站 codec 共用）。
 *
 * 错误信封政策：管线拒绝（4xx/429/402 等）是网关语义，统一 OpenAI 风格信封
 * （api-contract 单一错误信封），不按入站协议重塑——SDK 均按 HTTP 状态判定。
 */

export interface InboundCodec {
  /** 外部请求体 → 规范形（model 由路由层注入——gemini 原生端点模型在 URL） */
  decodeRequest(body: Record<string, unknown>, model: string): Record<string, unknown>;
  /** 规范形非流式成功响应 → 外部形 */
  encodeResponse(body: unknown): unknown;
  /** 规范形 SSE 流 → 外部线格式流 */
  encodeStream(stream: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array>;
}

/**
 * 响应侧编码包装：管线返回的规范形 Response → 外部线格式 Response。
 * - SSE 流：pipeThrough 线格式编码器（错误帧在编码器内映射为各协议事件形态）
 * - JSON：成功体做形状翻译；错误信封（error 字段）原样透传（网关语义单一信封）
 */
export async function encodeResponseForClient(
  response: Response,
  codec: InboundCodec,
  model: string,
): Promise<Response> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    if (!response.body) return response;
    return new Response(codec.encodeStream(response.body, model), {
      status: response.status,
      headers: response.headers,
    });
  }
  const cloned = response.clone();
  const json = (await cloned.json().catch(() => null)) as Record<string, unknown> | null;
  if (json === null || json.error !== undefined || !response.ok) {
    return response;
  }
  return new Response(JSON.stringify(codec.encodeResponse(json)), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}

export const claudeMessagesCodec: InboundCodec = {
  decodeRequest: (body) => claudeRequestToChat(body) as Record<string, unknown>,
  encodeResponse: (body) => chatResponseToClaude(body),
  encodeStream: (stream, model) => canonicalStreamToClaudeStream(stream, model),
};

export const geminiCodec: InboundCodec = {
  decodeRequest: (body, model) => geminiRequestToChat(body, model) as Record<string, unknown>,
  encodeResponse: (body) => chatResponseToGemini(body),
  encodeStream: (stream, model) => canonicalStreamToGeminiStream(stream, model),
};

export const responsesCodec: InboundCodec = {
  decodeRequest: (body) => responsesRequestToChat(body) as Record<string, unknown>,
  encodeResponse: (body) => chatResponseToResponses(body),
  encodeStream: (stream) => canonicalStreamToResponsesStream(stream),
};

export const completionsCodec: InboundCodec = {
  decodeRequest: (body) => completionsRequestToChat(body) as Record<string, unknown>,
  encodeResponse: (body) => chatResponseToCompletions(body),
  encodeStream: (stream) => canonicalStreamToCompletionsStream(stream),
};
