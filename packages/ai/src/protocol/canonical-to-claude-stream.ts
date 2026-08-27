/**
 * 规范形 OpenAI chunk 流 → Claude SSE 事件流（客户端侧流式 codec，从 claude-stream.ts
 * 按方向拆出；上游方向见 claude-upstream-to-canonical.ts，共享映射见 claude-stream-shared.ts）。
 */
import { sseToSseStream, type SseEvent } from '../transport/sse';
import { asArray, asJson, str } from './claude-chat';
import { claudeStopOf } from './claude-stream-shared';

/**
 * 规范形 OpenAI chunk 流 → Claude SSE 事件流（客户端侧，入站 /v1/messages 流式）。
 * 逐 chunk 合成 message_start / content_block_delta / message_delta / message_stop。
 */
// eslint-disable-next-line max-lines-per-function -- 双向 codec 的外壳（内层转换器另有豁免）：装配 + 终态收尾
export function canonicalStreamToClaudeStream(
  upstream: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const frame = (event: string, obj: Record<string, unknown>): Uint8Array =>
    enc.encode(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`);
  let started = false;
  let textOpen = false;
  const tools: Map<number, { id: string; name: string; args: string }> = new Map();
  // 计数器簇：input/output/缓存读/缓存写（同 0 初值，规范帧逐帧累计）
  let [inputTokens, outputTokens, cachedTokens, cacheWriteTokens] = [0, 0, 0, 0];
  let finishReason: string | null = null;
  let messageId = `msg_${Math.random().toString(36).slice(2, 14)}`;

  return sseToSseStream(
    upstream,
    // eslint-disable-next-line max-statements, complexity, max-lines-per-function -- 语句数随词表线性，拆分线程化状态得不偿失
    (ev: SseEvent, emit) => {
      if (ev.data === '[DONE]') {
        // [DONE] → message_delta(stop_reason) + message_stop
        if (!finishReason) finishReason = 'end_turn';
        emit(
          frame('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: claudeStopOf(finishReason) ?? 'end_turn' },
            usage: {
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              // 缓存字段还原为 claude 原生名（客户端 /v1/messages 面的保真）
              ...(cachedTokens > 0 ? { cache_read_input_tokens: cachedTokens } : {}),
              ...(cacheWriteTokens > 0 ? { cache_creation_input_tokens: cacheWriteTokens } : {}),
            },
          }),
        );
        if (textOpen) emit(frame('content_block_stop', { type: 'content_block_stop', index: 0 }));
        for (const idx of tools.keys()) {
          emit(frame('content_block_stop', { type: 'content_block_stop', index: idx + 1 }));
        }
        emit(frame('message_stop', { type: 'message_stop' }));
        return;
      }
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(ev.data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (chunk === null || typeof chunk !== 'object') return; // fuzz：data:null 帧不崩
      // 规范形错误帧（relay 注入/上游错误）→ claude error 事件
      if (chunk.error !== undefined) {
        const err = asJson(chunk.error) ?? {};
        emit(
          frame('error', {
            type: 'error',
            error: {
              type: str(err.type) ?? 'api_error',
              message: str(err.message) ?? 'stream error',
            },
          }),
        );
        return;
      }
      const choice = asJson(asArray(chunk.choices)[0]);
      const delta = asJson(choice?.delta) ?? {};
      if (!started) {
        started = true;
        if (typeof chunk.id === 'string') messageId = chunk.id;
        emit(
          frame('message_start', {
            type: 'message_start',
            message: {
              id: messageId,
              type: 'message',
              role: 'assistant',
              model,
              content: [],
              stop_reason: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          }),
        );
      }
      const usage = asJson(chunk.usage);
      if (usage) {
        inputTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : inputTokens;
        outputTokens =
          typeof usage.completion_tokens === 'number' ? usage.completion_tokens : outputTokens;
        const details = asJson(usage.prompt_tokens_details);
        if (details !== null && typeof details.cached_tokens === 'number') {
          cachedTokens = details.cached_tokens;
        }
        if (typeof usage.cache_write_tokens === 'number') {
          cacheWriteTokens = usage.cache_write_tokens;
        }
      }
      if (typeof delta.role === 'string' && !textOpen) {
        // role 帧 → 开文本块（claude 客户端兼容）
        textOpen = true;
        emit(
          frame('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          }),
        );
      }
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        if (!textOpen) {
          textOpen = true;
          emit(
            frame('content_block_start', {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            }),
          );
        }
        emit(
          frame('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: delta.content },
          }),
        );
      }
      for (const tc of asArray(delta.tool_calls)) {
        const call = asJson(tc);
        if (!call) continue;
        const fn = asJson(call.function) ?? {};
        const slot = typeof call.index === 'number' ? call.index : 0;
        if (!tools.has(slot)) {
          const toolUse = {
            id: str(call.id) ?? `toolu_${slot}`,
            name: str(fn.name) ?? '',
            args: '',
          };
          tools.set(slot, toolUse);
          emit(
            frame('content_block_start', {
              type: 'content_block_start',
              index: slot + 1,
              content_block: {
                type: 'tool_use',
                id: toolUse.id,
                name: toolUse.name,
                input: {},
              },
            }),
          );
        }
        if (typeof fn.arguments === 'string' && fn.arguments.length > 0) {
          emit(
            frame('content_block_delta', {
              type: 'content_block_delta',
              index: slot + 1,
              delta: { type: 'input_json_delta', partial_json: fn.arguments },
            }),
          );
        }
      }
      if (typeof choice?.finish_reason === 'string' && choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    },
    (emit) => {
      // 规范形流无 [DONE] 结束（异常）→ 补 message_stop 防客户端挂死
      if (started) {
        emit(
          frame('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: claudeStopOf(finishReason) ?? 'end_turn' },
            usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          }),
        );
        emit(frame('message_stop', { type: 'message_stop' }));
      }
    },
  );
}
