/**
 * Claude Messages ⇄ OpenAI Chat 流式 codec（从 claude-chat.ts 按单一职责拆出：
 * 本文件只装「流式双向转换」一个动词；请求/响应/usage 的非流式 codec 见 claude-chat.ts）。
 *
 *   ① claudeUpstreamToCanonicalStream   Claude SSE 事件流 → 规范形 OpenAI chunk 流（上游侧）
 *   ② canonicalStreamToClaudeStream     规范形 chunk 流 → Claude SSE 事件流（客户端侧，入站 /v1/messages 流式）
 *
 * usage 语义归一沿用 claude-chat.claudeUsageToUsage（单一真相）：
 * cache_read_input_tokens → cachedInputTokens；cache_creation_input_tokens 计入未缓存输入。
 */
import { openaiDone, openaiFrame, sseToSseStream, type SseEvent } from '../transport/sse';
import { asArray, asJson, claudeUsageToUsage, str } from './claude-chat';

/** claude stop_reason → OpenAI finish_reason（上游方向，message_delta 映射） */
const STOP_REASON_MAP: Record<string, string> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
};

/**
 * Claude SSE 事件流 → 规范形 OpenAI chunk 流（上游侧）。
 * message_start → role 帧；content_block_delta(text_delta) → content delta；
 * content_block_delta(input_json_delta) → tool_calls delta；
 * message_delta(stop_reason/usage) → finish_reason 帧 + usage 帧；message_stop → [DONE]。
 * 真实模型名从 message_start.message.model 提取写入规范帧（v1 同语义——
 * 出站如需对外目录名，由 relay 的响应侧 model 替换开关统一处理，§3.6 例外 2）。
 */
export function claudeUpstreamToCanonicalStream(
  upstream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  let model = '';
  let id = 'chatcmpl-claude';
  let blockIndexToTool: Map<number, { index: number; id: string; name: string }> = new Map();
  let toolCallIndex = 0;
  let inputTokens = 0;
  let lastCompletionTokens: number | null = null;
  let cachedTokens = 0;
  let cacheWriteTokens = 0;
  let emitUsage = false;
  let doneSent = false;

  return sseToSseStream(
    upstream,
    (ev: SseEvent, emit) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(ev.data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (data === null || typeof data !== 'object') return; // fuzz：data:null 帧不崩
      if (data.type === 'message_start') {
        const msg = asJson(data.message) ?? {};
        model = str(msg.model) ?? model;
        id = str(msg.id) ?? id;
        // message_start 的 usage 无 output_tokens——补 0 后解析（否则严格双字段判 null，input 侧永不被捕获）
        const mu = asJson(msg.usage);
        if (mu) {
          const cu = claudeUsageToUsage({
            ...mu,
            output_tokens: typeof mu.output_tokens === 'number' ? mu.output_tokens : 0,
          });
          if (cu) {
            inputTokens = cu.promptTokens;
            cachedTokens = cu.cachedTokens;
            cacheWriteTokens = cu.cacheCreationTokens;
          }
        }
        return;
      }
      if (data.type === 'content_block_start') {
        const idx = typeof data.index === 'number' ? data.index : 0;
        const block = asJson(data.content_block);
        if (block?.type === 'tool_use') {
          const slot = toolCallIndex++;
          blockIndexToTool.set(idx, {
            index: slot,
            id: str(block.id) ?? `call_${slot}`,
            name: str(block.name) ?? '',
          });
          emit(
            openaiFrame({
              id,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: slot,
                        id: blockIndexToTool.get(idx)!.id,
                        type: 'function',
                        function: { name: blockIndexToTool.get(idx)!.name, arguments: '' },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            }),
          );
        }
        return;
      }
      if (data.type === 'content_block_delta') {
        const idx = typeof data.index === 'number' ? data.index : 0;
        const delta = asJson(data.delta) ?? {};
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          emit(
            openaiFrame({
              id,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }],
            }),
          );
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const tool = blockIndexToTool.get(idx);
          if (tool) {
            emit(
              openaiFrame({
                id,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        { index: tool.index, function: { arguments: delta.partial_json } },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              }),
            );
          }
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          // 思考增量 → reasoning_content（DeepSeek 风格，规范形 passthrough 字段）
          emit(
            openaiFrame({
              id,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [
                { index: 0, delta: { reasoning_content: delta.thinking }, finish_reason: null },
              ],
            }),
          );
        }
        return;
      }
      if (data.type === 'message_delta') {
        const delta = asJson(data.delta) ?? {};
        // Anthropic 语义：message_delta.usage 只带 output_tokens（input 侧在 message_start）——
        // 严格双字段解析会永远拒绝它（流式 usage 因此从未发出，计费全走估算）。
        // 宽松读取：output 侧直接取；完整形态出现时才覆盖 input/缓存侧。
        const du = asJson(data.usage);
        if (du !== null && typeof du.output_tokens === 'number') {
          lastCompletionTokens = du.output_tokens;
        }
        const usage = du !== null ? claudeUsageToUsage(du) : null;
        if (usage) {
          inputTokens = usage.promptTokens;
          cachedTokens = usage.cachedTokens;
          cacheWriteTokens = usage.cacheCreationTokens;
        }
        const stopReason = str(delta.stop_reason);
        if (stopReason !== undefined) {
          emitUsage = true;
          emit(
            openaiFrame({
              id,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [
                { index: 0, delta: {}, finish_reason: STOP_REASON_MAP[stopReason] ?? 'stop' },
              ],
              ...(lastCompletionTokens !== null && inputTokens > 0
                ? {
                    usage: {
                      prompt_tokens: inputTokens,
                      completion_tokens: lastCompletionTokens,
                      total_tokens: inputTokens + lastCompletionTokens,
                      ...(cachedTokens > 0
                        ? { prompt_tokens_details: { cached_tokens: cachedTokens } }
                        : {}),
                      ...(cacheWriteTokens > 0 ? { cache_write_tokens: cacheWriteTokens } : {}),
                    },
                  }
                : {}),
            }),
          );
        }
        return;
      }
      if (data.type === 'message_stop') {
        doneSent = true;
        emit(openaiDone());
      }
      // error 事件：透传给规范形错误帧（relay scanner 识别 {error:...}）
      if (data.type === 'error') {
        const err = asJson(data.error) ?? {};
        emit(
          openaiFrame({
            error: {
              code: str(err.type) ?? 'upstream_error',
              type: str(err.type),
              message: str(err.message) ?? 'claude stream error',
            },
          }),
        );
        doneSent = true;
        emit(openaiDone());
      }
    },
    (emit) => {
      // 兜底：上游没有 message_delta（异常断流）也保证 usage 帧与 [DONE] 尽力补齐
      if (emitUsage === false && inputTokens > 0 && lastCompletionTokens !== null) {
        emit(
          openaiFrame({
            id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: inputTokens,
              completion_tokens: lastCompletionTokens,
              total_tokens: inputTokens + lastCompletionTokens,
              ...(cachedTokens > 0
                ? { prompt_tokens_details: { cached_tokens: cachedTokens } }
                : {}),
              ...(cacheWriteTokens > 0 ? { cache_write_tokens: cacheWriteTokens } : {}),
            },
          }),
        );
      }
      if (!doneSent) emit(openaiDone());
    },
  );
}

/**
 * 规范形 OpenAI chunk 流 → Claude SSE 事件流（客户端侧，入站 /v1/messages 流式）。
 * 逐 chunk 合成 message_start / content_block_delta / message_delta / message_stop。
 */
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
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let cacheWriteTokens = 0;
  let finishReason: string | null = null;
  let messageId = 'msg_' + Math.random().toString(36).slice(2, 14);

  return sseToSseStream(
    upstream,
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
        if (details !== null && typeof details.cached_tokens === 'number')
          cachedTokens = details.cached_tokens;
        if (typeof usage.cache_write_tokens === 'number')
          cacheWriteTokens = usage.cache_write_tokens;
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
          tools.set(slot, {
            id: str(call.id) ?? `toolu_${slot}`,
            name: str(fn.name) ?? '',
            args: '',
          });
          emit(
            frame('content_block_start', {
              type: 'content_block_start',
              index: slot + 1,
              content_block: {
                type: 'tool_use',
                id: tools.get(slot)!.id,
                name: tools.get(slot)!.name,
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

/** finish_reason → claude stop_reason（模块级纯函数，客户端方向） */
const claudeStopOf = (finish: string | null): string | null => {
  if (finish === 'length') return 'max_tokens';
  if (finish === 'tool_calls') return 'tool_use';
  if (finish === 'content_filter') return 'refusal';
  if (finish === 'stop' || finish === null) return finish === null ? null : 'end_turn';
  return 'end_turn';
};
