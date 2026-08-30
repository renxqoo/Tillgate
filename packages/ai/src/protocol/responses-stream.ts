/**
 * OpenAI Responses 流式出站（codec 家族流式件，同 claude-stream/gemini-stream 拆分）：
 * 规范形 chunk 流 → Responses SSE 事件流。
 *
 * 事件词表：response.created / response.output_item.added（message · reasoning ·
 * function_call）/ response.output_text.delta · done /
 * response.reasoning_summary_text.delta / response.function_call_arguments.delta /
 * response.output_item.done / response.completed · response.incomplete
 * （finish_reason=length）/ response.failed。
 * 终态单发（DONE 与 flush 兜底共用聚合终态）；completed/incomplete.output 携带
 * 完整聚合结果（reasoning → message → function_calls）。
 */
import { sseToSseStream, type SseEvent } from '../transport/sse';
import { asArray, asJson, reasoningItem, str, type Json } from './responses-chat';

/** 流式 tool_calls 累积器（按 index 归并分片：id/name 首帧、arguments 逐帧拼接） */
interface StreamToolCall {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

/** Responses message output item（completed 态携带聚合正文） */
const messageItem = (status: 'in_progress' | 'completed', text: string): Json => ({
  type: 'message',
  id: 'msg_gateway',
  status,
  role: 'assistant',
  content: status === 'completed' ? [{ type: 'output_text', text, annotations: [] }] : [],
});

/** function_call output item 形状（stream 累积器 → item/done/终态 output 共用） */
function functionCallItem(call: StreamToolCall): Json {
  return {
    type: 'function_call',
    id: call.id,
    call_id: call.id,
    name: call.name,
    arguments: call.arguments,
    status: 'completed',
  };
}

/** output_item.done 事件帧 */
function emitItemDone(
  ev: (event: string, obj: Record<string, unknown>) => Uint8Array,
  emit: (frame: Uint8Array) => void,
  args: { outputIndex: number; item: unknown },
): void {
  emit(
    ev('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: args.outputIndex,
      item: args.item,
    }),
  );
}

/** 终态 response 对象（completed / incomplete(finish_reason=length) 共用形状） */
function terminalResponse(args: {
  responseId: string;
  incomplete: boolean;
  output: unknown[];
  usage: { inputTokens: number; outputTokens: number };
}): Record<string, unknown> {
  const { responseId, incomplete, output, usage } = args;
  return {
    id: responseId,
    object: 'response',
    status: incomplete ? 'incomplete' : 'completed',
    ...(incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    output,
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      total_tokens: usage.inputTokens + usage.outputTokens,
    },
  };
}

// eslint-disable-next-line max-lines-per-function -- 双向 codec 外壳（装配 + 终态收尾）
export function canonicalStreamToResponsesStream(
  upstream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const ev = (event: string, obj: Record<string, unknown>): Uint8Array =>
    enc.encode(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`);
  const responseId = `resp_${Math.random().toString(36).slice(2, 12)}`;
  let created = false;
  let itemAdded = false;
  /** 终态事件只发一次（DONE 分支已发时，flush 兜底不再补发） */
  let terminalEmitted = false;
  let nextOutputIndex = 0;
  let messageOutputIndex = 0;
  let reasoningAdded = false;
  let reasoningOutputIndex = 0;
  const reasoningParts: string[] = [];
  const textParts: string[] = [];
  /** index → 累积调用（输出序 = 首帧到达序） */
  /** tool_calls 分桶（输出序 = 首帧到达序）：id → 调用；index → 最近调用（无 id 续接片挂靠） */
  const callsById = new Map<string, StreamToolCall>();
  const lastCallByIndex = new Map<number, StreamToolCall>();
  const orderedCalls: StreamToolCall[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason: string | undefined;

  /** 聚合终态（DONE 与 flush 兜底共用）：输出序 reasoning → message → function_calls */
  const emitTerminal = (emit: (frame: Uint8Array) => void): void => {
    if (terminalEmitted) return;
    terminalEmitted = true;
    const fullText = textParts.join('');
    const fullReasoning = reasoningParts.join('');
    if (reasoningAdded) {
      emitItemDone(ev, emit, {
        outputIndex: reasoningOutputIndex,
        item: reasoningItem('completed', fullReasoning),
      });
    }
    if (itemAdded) {
      emit(
        ev('response.output_text.done', {
          type: 'response.output_text.done',
          item_id: 'msg_gateway',
          output_index: messageOutputIndex,
          content_index: 0,
          text: fullText,
        }),
      );
      emitItemDone(ev, emit, {
        outputIndex: messageOutputIndex,
        item: messageItem('completed', fullText),
      });
    }
    const output: unknown[] = [];
    if (reasoningAdded) output.push(reasoningItem('completed', fullReasoning));
    if (itemAdded) output.push(messageItem('completed', fullText));
    for (const call of orderedCalls) {
      const item = functionCallItem(call);
      emitItemDone(ev, emit, { outputIndex: call.index, item });
      output.push(item);
    }
    emit(
      ev(finishReason === 'length' ? 'response.incomplete' : 'response.completed', {
        type: finishReason === 'length' ? 'response.incomplete' : 'response.completed',
        response: terminalResponse({
          responseId,
          incomplete: finishReason === 'length',
          output,
          usage: { inputTokens, outputTokens },
        }),
      }),
    );
  };

  return sseToSseStream(
    upstream,
    // eslint-disable-next-line complexity, max-lines-per-function, max-statements -- 逐事件类型翻译的单闭包状态机（responses 事件词表穷举；同 claude/gemini codec 惯例）
    (sse: SseEvent, emit) => {
      if (sse.data === '[DONE]') {
        if (created) emitTerminal(emit);
        return;
      }
      let chunk: Json;
      try {
        chunk = JSON.parse(sse.data) as Json;
      } catch {
        return;
      }
      if (chunk === null || typeof chunk !== 'object') return; // fuzz：data:null 帧不崩
      if (!created) {
        created = true;
        emit(
          ev('response.created', {
            type: 'response.created',
            response: { id: responseId, object: 'response', status: 'in_progress', output: [] },
          }),
        );
      }
      const usage = asJson(chunk.usage);
      if (usage) {
        inputTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : inputTokens;
        outputTokens =
          typeof usage.completion_tokens === 'number' ? usage.completion_tokens : outputTokens;
      }
      if (chunk.error !== undefined) {
        const err = asJson(chunk.error) ?? {};
        emit(
          ev('response.failed', {
            type: 'response.failed',
            response: {
              id: responseId,
              object: 'response',
              status: 'failed',
              error: {
                code: str(err.code) ?? 'upstream_error',
                message: str(err.message) ?? 'stream error',
              },
            },
          }),
        );
        // failed 即终态（Responses SSE 恰好一个终态事件）——后续 DONE/flush 不再补 completed
        terminalEmitted = true;
        return;
      }
      const choice = asJson(asArray(chunk.choices)[0]);
      const finish = str(choice?.finish_reason);
      if (finish !== undefined && finish !== 'null') finishReason = finish;
      const delta = asJson(choice?.delta) ?? {};
      // 上游思考增量（claude thinking_delta / deepseek reasoning 归一）→ reasoning summary 事件
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
        if (!reasoningAdded) {
          reasoningAdded = true;
          reasoningOutputIndex = nextOutputIndex;
          nextOutputIndex += 1;
          emit(
            ev('response.output_item.added', {
              type: 'response.output_item.added',
              output_index: reasoningOutputIndex,
              item: reasoningItem('in_progress', ''),
            }),
          );
        }
        reasoningParts.push(delta.reasoning_content);
        emit(
          ev('response.reasoning_summary_text.delta', {
            type: 'response.reasoning_summary_text.delta',
            item_id: 'rs_gateway',
            output_index: reasoningOutputIndex,
            summary_index: 0,
            delta: delta.reasoning_content,
          }),
        );
      }
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        if (!itemAdded) {
          itemAdded = true;
          messageOutputIndex = nextOutputIndex;
          nextOutputIndex += 1;
          emit(
            ev('response.output_item.added', {
              type: 'response.output_item.added',
              output_index: messageOutputIndex,
              item: messageItem('in_progress', ''),
            }),
          );
        }
        textParts.push(delta.content);
        emit(
          ev('response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: 'msg_gateway',
            output_index: messageOutputIndex,
            content_index: 0,
            delta: delta.content,
          }),
        );
      }
      for (const tc of asArray(delta.tool_calls)) {
        const c = asJson(tc);
        if (c == null) continue;
        const idx = typeof c.index === 'number' ? c.index : 0;
        const fragId = str(c.id);
        const fn = asJson(c.function);
        // 分桶：带 id 分片按 id 归并（厂商复用 index 换 id = 新调用——不把两个
        // 调用的参数串接成静默损坏的 JSON）；无 id 的续接分片挂该 index 最近一次
        // 调用（流式惯例：仅首帧携带 id）
        let call = fragId != null ? callsById.get(fragId) : lastCallByIndex.get(idx);
        if (call === undefined || (fragId != null && call.id !== fragId)) {
          call = {
            index: nextOutputIndex,
            id: fragId ?? `call_${idx}_${callsById.size}`,
            name: str(fn?.name) ?? '',
            arguments: '',
          };
          callsById.set(call.id, call);
          lastCallByIndex.set(idx, call);
          orderedCalls.push(call);
          nextOutputIndex += 1;
          emit(
            ev('response.output_item.added', {
              type: 'response.output_item.added',
              output_index: call.index,
              item: {
                type: 'function_call',
                id: call.id,
                call_id: call.id,
                name: call.name,
                status: 'in_progress',
                arguments: '',
              },
            }),
          );
        }
        const argsFragment = str(fn?.arguments) ?? '';
        if (argsFragment.length > 0) {
          call.arguments += argsFragment;
          emit(
            ev('response.function_call_arguments.delta', {
              type: 'response.function_call_arguments.delta',
              item_id: call.id,
              output_index: call.index,
              delta: argsFragment,
            }),
          );
        }
      }
    },
    // 流意外终结（无 [DONE] 帧）兜底：按已聚合内容发终态，不静默吞流
    (emit) => {
      if (created) emitTerminal(emit);
    },
  );
}
