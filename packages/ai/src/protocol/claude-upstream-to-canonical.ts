/**
 * Claude SSE 事件流 → 规范形 OpenAI chunk 流（上游侧流式 codec，从 claude-stream.ts
 * 按方向拆出；客户端方向见 canonical-to-claude-stream.ts，共享映射见 claude-stream-shared.ts）。
 *
 * usage 语义归一沿用 claude-chat.claudeUsageToUsage（单一真相）：
 * cache_read_input_tokens → cachedInputTokens；cache_creation_input_tokens 计入未缓存输入。
 */
import { openaiDone, openaiFrame, sseToSseStream, type SseEvent } from '../transport/sse';
import { asJson, claudeUsageToUsage, str } from './claude-chat';
import { STOP_REASON_MAP } from './claude-stream-shared';

/**
 * Claude SSE 事件流 → 规范形 OpenAI chunk 流（上游侧）。
 * message_start → role 帧；content_block_delta(text_delta) → content delta；
 * content_block_delta(input_json_delta) → tool_calls delta；
 * message_delta(stop_reason/usage) → finish_reason 帧 + usage 帧；message_stop → [DONE]。
 * 真实模型名从 message_start.message.model 提取写入规范帧——
 * 出站如需对外目录名，由 relay 的响应侧 model 替换开关统一处理。
 */
// eslint-disable-next-line max-lines-per-function -- 双向 codec 的外壳（内层转换器另有豁免）：装配 + 终态收尾
export function claudeUpstreamToCanonicalStream(
  upstream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  let model = '';
  let id = 'chatcmpl-claude';
  const blockIndexToTool: Map<number, { index: number; id: string; name: string }> = new Map();
  let toolCallIndex = 0;
  let lastCompletionTokens: number | null = null;
  // 计数器簇：input/缓存读/缓存写（同 0 初值，事件侧逐帧累计）
  let [inputTokens, cachedTokens, cacheWriteTokens] = [0, 0, 0];
  let emitUsage = false;
  let doneSent = false;

  return sseToSseStream(
    upstream,
    // eslint-disable-next-line max-lines-per-function, complexity, max-statements -- 逐事件类型翻译的单闭包状态机（claude 事件词表 7+ 型），拆分需跨函数线程化状态
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
            ({
              promptTokens: inputTokens,
              cachedTokens,
              cacheCreationTokens: cacheWriteTokens,
            } = cu);
          }
        }
        return;
      }
      if (data.type === 'content_block_start') {
        const idx = typeof data.index === 'number' ? data.index : 0;
        const block = asJson(data.content_block);
        if (block?.type === 'tool_use') {
          const slot = toolCallIndex++;
          const toolCall = {
            index: slot,
            id: str(block.id) ?? `call_${slot}`,
            name: str(block.name) ?? '',
          };
          blockIndexToTool.set(idx, toolCall);
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
                        id: toolCall.id,
                        type: 'function',
                        function: { name: toolCall.name, arguments: '' },
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
          ({
            promptTokens: inputTokens,
            cachedTokens,
            cacheCreationTokens: cacheWriteTokens,
          } = usage);
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
