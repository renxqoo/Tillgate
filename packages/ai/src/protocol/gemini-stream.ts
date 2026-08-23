import { openaiDone, openaiFrame, sseToSseStream, type SseEvent } from '../transport/sse';
import { asArray, asJson, str, FINISH_MAP, type Json } from './gemini-shared';
import { geminiUsageToUsage } from './gemini-chat';

/**
 * Gemini 流式双向 codec（chat 家族 ④，与 gemini-chat.ts 的①②③按 claude-chat/claude-stream
 * 同款约定分文件）：
 *   ④a geminiUpstreamToCanonicalStream   Gemini alt=sse 上游流 → 规范形 chunk 流
 *   ④b canonicalStreamToGeminiStream     规范形 chunk 流 → Gemini alt=sse 数据帧（客户端入站）
 *
 * usage 语义与 gemini-chat.ts 一致：promptTokenCount → inputTokens、
 * cachedContentTokenCount 扣出 cached、thoughtsTokenCount 计入 output。
 */

/** Gemini alt=sse 数据帧（JSON，无 [DONE]，finishReason 终止）→ 规范形 chunk 流（model 透传入帧——v1 语义） */
export function geminiUpstreamToCanonicalStream(
  upstream: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  let started = false;
  let toolCallIndex = 0;
  return sseToSseStream(
    upstream,
    (ev: SseEvent, emit) => {
      let data: Json;
      try {
        data = JSON.parse(ev.data) as Json;
      } catch {
        return;
      }
      if (data === null || typeof data !== 'object') return; // fuzz：data:null 帧不崩
      if (!started) {
        started = true;
        emit(
          openaiFrame({
            id: 'chatcmpl-gemini',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
          }),
        );
      }
      if (data.error !== undefined) {
        const err = asJson(data.error) ?? {};
        emit(
          openaiFrame({
            error: {
              code: str(err.status) ?? str(err.code) ?? 'upstream_error',
              type: str(err.status),
              message: str(err.message) ?? 'gemini stream error',
            },
          }),
        );
        emit(openaiDone());
        return;
      }
      const candidate = asJson(asArray(data.candidates)[0]);
      const parts = asArray(asJson(candidate?.content)?.parts);
      for (const p of parts) {
        const part = asJson(p);
        if (!part) continue;
        if (typeof part.text === 'string' && part.text.length > 0) {
          emit(
            openaiFrame({
              id: 'chatcmpl-gemini',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { content: part.text }, finish_reason: null }],
            }),
          );
        }
        // functionCall part → tool_calls delta（v1 遗留缺口修复：Gemini 每调用完整下发，
        // 与 OpenAI 流式增量不同——name+arguments 一次性发出，无分片续接）
        const fc = asJson(part.functionCall);
        if (fc !== null && typeof fc.name === 'string') {
          emit(
            openaiFrame({
              id: 'chatcmpl-gemini',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: toolCallIndex,
                        id: `call_g${toolCallIndex}`,
                        type: 'function',
                        function: { name: fc.name, arguments: JSON.stringify(fc.args ?? {}) },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            }),
          );
          toolCallIndex += 1;
        }
      }
      const finish = str(candidate?.finishReason);
      const usage = geminiUsageToUsage(data.usageMetadata);
      if (finish !== undefined) {
        emit(
          openaiFrame({
            id: 'chatcmpl-gemini',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: {}, finish_reason: FINISH_MAP[finish] ?? 'stop' }],
            ...(usage
              ? {
                  usage: {
                    prompt_tokens: usage.promptTokens,
                    completion_tokens: usage.completionTokens,
                    total_tokens: usage.promptTokens + usage.completionTokens,
                    ...(usage.cachedTokens > 0
                      ? { prompt_tokens_details: { cached_tokens: usage.cachedTokens } }
                      : {}),
                  },
                }
              : {}),
          }),
        );
        emit(openaiDone());
      } else if (usage) {
        // 中间帧也可能带 usage（思考 token 计数更新）——最后帧胜出语义由 scanner 保证
        emit(
          openaiFrame({
            id: 'chatcmpl-gemini',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: {}, finish_reason: null }],
            usage: {
              prompt_tokens: usage.promptTokens,
              completion_tokens: usage.completionTokens,
              total_tokens: usage.promptTokens + usage.completionTokens,
              ...(usage.cachedTokens > 0
                ? { prompt_tokens_details: { cached_tokens: usage.cachedTokens } }
                : {}),
            },
          }),
        );
      }
    },
    (emit) => {
      // Gemini 无哨兵：flush 兜底补 [DONE]（截断检测由 relay 完成语义承担）
      emit(openaiDone());
    },
  );
}

/** 规范形 chunk 流 → Gemini alt=sse 数据帧流（客户端侧，入站 gemini 流式） */
export function canonicalStreamToGeminiStream(
  upstream: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const frame = (obj: Record<string, unknown>): Uint8Array =>
    enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason: string | null = null;

  return sseToSseStream(
    upstream,
    (ev: SseEvent, emit) => {
      if (ev.data === '[DONE]') {
        emit(
          frame({
            candidates: [
              { content: { role: 'model', parts: [] }, finishReason: geminiFinishOf(finishReason) },
            ],
            usageMetadata: {
              promptTokenCount: inputTokens,
              candidatesTokenCount: outputTokens,
              totalTokenCount: inputTokens + outputTokens,
            },
            modelVersion: model,
          }),
        );
        return;
      }
      let chunk: Json;
      try {
        chunk = JSON.parse(ev.data) as Json;
      } catch {
        return;
      }
      if (chunk === null || typeof chunk !== 'object') return; // fuzz：data:null 帧不崩
      if (chunk.error !== undefined) {
        const err = asJson(chunk.error) ?? {};
        emit(
          frame({
            error: {
              code: 500,
              message: str(err.message) ?? 'stream error',
              status: str(err.type) ?? 'INTERNAL',
            },
          }),
        );
        return;
      }
      const choice = asJson(asArray(chunk.choices)[0]);
      const delta = asJson(choice?.delta) ?? {};
      const usage = asJson(chunk.usage);
      if (usage) {
        inputTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : inputTokens;
        outputTokens =
          typeof usage.completion_tokens === 'number' ? usage.completion_tokens : outputTokens;
      }
      const parts: Array<Record<string, unknown>> = [];
      if (typeof delta.content === 'string' && delta.content.length > 0)
        parts.push({ text: delta.content });
      for (const tc of asArray(delta.tool_calls)) {
        const call = asJson(tc);
        const fn = asJson(call?.function);
        if (!fn) continue;
        if (typeof fn.name === 'string' && fn.name) {
          let args: unknown = {};
          try {
            args = JSON.parse(str(fn.arguments) ?? '{}');
          } catch {
            args = {};
          }
          parts.push({ functionCall: { name: fn.name, args } });
        }
      }
      if (typeof choice?.finish_reason === 'string' && choice.finish_reason)
        finishReason = choice.finish_reason;
      if (parts.length > 0) {
        emit(frame({ candidates: [{ content: { role: 'model', parts } }] }));
      }
    },
    (emit) => {
      emit(
        frame({
          candidates: [
            { content: { role: 'model', parts: [] }, finishReason: geminiFinishOf(finishReason) },
          ],
        }),
      );
    },
  );
}

/** finish_reason → gemini finishReason（模块级纯函数） */
const geminiFinishOf = (finish: string | null): string => {
  if (finish === 'length') return 'MAX_TOKENS';
  if (finish === 'content_filter') return 'SAFETY';
  return 'STOP';
};
