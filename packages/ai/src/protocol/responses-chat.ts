import { sseToSseStream, type SseEvent } from '../transport/sse';

/**
 * OpenAI Responses ⇄ Chat 入站 codec（/v1/responses 端点用，仅客户端方向）。
 *
 * ① responsesRequestToChat  Responses 请求 → 规范形 chat 请求
 * ② chatResponseToResponses 规范形非流式响应 → Responses 响应
 * ③ canonicalStreamToResponsesStream 规范形 chunk 流 → Responses SSE 事件流
 *
 * 覆盖子集：input（string 或 message 数组）、instructions→system、
 * max_output_tokens、temperature、top_p、stream。输出事件：
 * response.created / response.output_item.added / response.output_text.delta /
 * response.output_text.done / response.completed。
 */

type Json = Record<string, unknown>;

function asJson(v: unknown): Json | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null;
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function responsesRequestToChat(req: unknown): Json {
  const r = asJson(req) ?? {};
  const messages: unknown[] = [];
  const instructions = str(r.instructions);
  if (instructions) messages.push({ role: 'system', content: instructions });
  if (typeof r.input === 'string') {
    messages.push({ role: 'user', content: r.input });
  } else {
    for (const item of asArray(r.input)) {
      const m = asJson(item);
      if (!m) continue;
      const role = str(m.role);
      // input_text / output_text 内容块
      const contentOf = (v: unknown): string => {
        if (typeof v === 'string') return v;
        return asArray(v)
          .map((b) => str(asJson(b)?.text) ?? '')
          .join('');
      };
      if (role === 'user' || role === 'assistant' || role === 'system' || role === 'developer') {
        messages.push({ role: role === 'developer' ? 'system' : role, content: contentOf(m.content) });
      }
    }
  }
  const out: Json = { model: str(r.model) ?? '', messages };
  if (typeof r.max_output_tokens === 'number') out.max_tokens = r.max_output_tokens;
  if (typeof r.temperature === 'number') out.temperature = r.temperature;
  if (typeof r.top_p === 'number') out.top_p = r.top_p;
  if (r.stream === true) out.stream = true;
  return out;
}

export function chatResponseToResponses(res: unknown): Json {
  const r = asJson(res) ?? {};
  const choice = asJson(asArray(r.choices)[0]) ?? {};
  const message = asJson(choice.message) ?? {};
  const text = typeof message.content === 'string' ? message.content : '';
  const usage = asJson(r.usage);
  return {
    id: str(r.id) ?? 'resp_gateway',
    object: 'response',
    created_at: typeof r.created === 'number' ? r.created : Math.floor(Date.now() / 1000),
    status: 'completed',
    model: str(r.model) ?? '',
    output: [
      {
        type: 'message',
        id: 'msg_gateway',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
      output_tokens: typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : 0,
      total_tokens: typeof usage?.total_tokens === 'number' ? usage.total_tokens : 0,
    },
  };
}

export function canonicalStreamToResponsesStream(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const ev = (event: string, obj: Record<string, unknown>): Uint8Array =>
    enc.encode(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`);
  const responseId = 'resp_' + Math.random().toString(36).slice(2, 12);
  let created = false;
  let itemAdded = false;
  let inputTokens = 0;
  let outputTokens = 0;

  return sseToSseStream(
    upstream,
    (sse: SseEvent, emit) => {
      if (sse.data === '[DONE]') {
        if (!created) return;
        emit(ev('response.output_text.done', { type: 'response.output_text.done', item_id: 'msg_gateway', output_index: 0, content_index: 0, text: '' }));
        emit(ev('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_gateway', status: 'completed', role: 'assistant', content: [] } }));
        emit(ev('response.completed', {
          type: 'response.completed',
          response: { id: responseId, object: 'response', status: 'completed', output: [], usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens } },
        }));
        return;
      }
      let chunk: Json;
      try {
        chunk = JSON.parse(sse.data) as Json;
      } catch {
        return;
      }
      if (!created) {
        created = true;
        emit(ev('response.created', { type: 'response.created', response: { id: responseId, object: 'response', status: 'in_progress', output: [] } }));
      }
      const usage = asJson(chunk.usage);
      if (usage) {
        inputTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : inputTokens;
        outputTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : outputTokens;
      }
      if (chunk.error !== undefined) {
        const err = asJson(chunk.error) ?? {};
        emit(ev('response.failed', { type: 'response.failed', response: { id: responseId, object: 'response', status: 'failed', error: { code: str(err.code) ?? 'upstream_error', message: str(err.message) ?? 'stream error' } } }));
        return;
      }
      const choice = asJson(asArray(chunk.choices)[0]);
      const delta = asJson(choice?.delta) ?? {};
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        if (!itemAdded) {
          itemAdded = true;
          emit(ev('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_gateway', status: 'in_progress', role: 'assistant', content: [] } }));
        }
        emit(ev('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_gateway', output_index: 0, content_index: 0, delta: delta.content }));
      }
    },
    (emit) => {
      if (created) {
        emit(ev('response.completed', { type: 'response.completed', response: { id: responseId, object: 'response', status: 'completed', output: [] } }));
      }
    },
  );
}
