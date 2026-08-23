/**
 * 流式终态报告件：per-call 事件总线（终态缓冲 + 晚订阅重放）+ relay 事件 → AiEvent 翻译。
 */
import type { RelayStreamEvent, RelayStreamHandle } from '../transport/relay-stream';
import { normalizeUsage } from '../usage/normalize';
import type { AiEvent, ChatStreamResult, UpstreamError, Usage } from '../types';
import { emitTo } from './context';

export interface StreamEventBus {
  providerName?: string;
  model?: string;
  emitStream: (e: AiEvent) => void;
  emitTerminal: (e: AiEvent) => void;
  /** 惰性注册返回给外部的 subscribe（缓冲重放） */
  bind(): ChatStreamResult['events'];
  subscribe(cb: (e: AiEvent) => void): void;
}

export function createStreamEventBus(
  emit: (e: AiEvent) => void,
  meta: { providerName?: string; model?: string } = {},
): StreamEventBus {
  const terminalBuffer: AiEvent[] = [];
  // first_chunk 一次性缓冲 + 幂等单发：chatStream 返回前即合成发火（上游首字节
  // 已被 peek 锁定），而 relay 的 transform 侧 first_chunk 要等客户端读流才触发
  // （TransformStream 需求耦合）——不合成则消费方（inference 的 decisive 锚）
  // 与响应启动互等成死锁；relay 侧晚到的重复 first_chunk 按幂等吞掉。
  // 与终态同规则：晚订阅重放。
  let firstChunkBuffered: AiEvent | null = null;
  const callCbs: Array<(e: AiEvent) => void> = [];
  let globalBound = false;
  const push = (e: AiEvent): void => {
    if (e.type === 'first_chunk') {
      if (firstChunkBuffered !== null) return; // 幂等：一次性事件只出一次
      firstChunkBuffered = e;
    }
    emit(e);
    for (const cb of callCbs.slice()) {
      try {
        cb(e);
      } catch {
        /* 观察者异常不反噬 */
      }
    }
  };
  const replayTo = (cb: (e: AiEvent) => void): void => {
    const replay =
      firstChunkBuffered !== null ? [firstChunkBuffered, ...terminalBuffer] : terminalBuffer;
    for (const e of replay.slice()) {
      try {
        cb(e);
      } catch {
        /* 重放异常忽略 */
      }
    }
  };
  const bus: StreamEventBus = {
    ...meta,
    subscribe: (cb) => {
      callCbs.push(cb);
      replayTo(cb);
    },
    emitStream: push,
    emitTerminal: (e) => {
      terminalBuffer.push(e);
      push(e);
    },
    bind: () => ({
      subscribe: (cb) => {
        callCbs.push(cb);
        replayTo(cb);
        if (!globalBound) {
          globalBound = true;
        }
      },
    }),
  };
  return bus;
}

/**
 * 流开始前失败的早退流（含 OpenAI 兼容错误帧 + failed 终态）。
 * sanitizeMessage：C 端错误帧 message 的出站脱敏（§3.6 例外 3 内容层）——
 * 事件面（emitTerminal）携带原始错误不脱敏（观察面/日志保真），仅出站字节脱敏。
 */
export function failEarlyStream(
  bus: StreamEventBus,
  error: UpstreamError,
  requestId: string,
  channelKey: string,
  sanitizeMessage?: (message: string) => string,
): ChatStreamResult {
  bus.emitTerminal({ type: 'failed', requestId, channelKey, error });
  const message = sanitizeMessage !== undefined ? sanitizeMessage(error.message) : error.message;
  const frame = `data: ${JSON.stringify({ error: { code: error.kind, type: error.vendorCode, message } })}\n\n`;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(frame));
      c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  return { stream, events: bus.bind() };
}

/** relay 管线事件 → AiEvent 翻译并挂到 handle（usage 归一 + terminated 随行） */
export function attachRelayReporting(
  handle: RelayStreamHandle,
  deps: {
    bus: StreamEventBus;
    requestId: string;
    channelKey: string;
    startedAt: number;
  },
): void {
  const { bus, requestId, channelKey, startedAt } = deps;
  handle.onEvent((ev: RelayStreamEvent) => {
    switch (ev.type) {
      case 'first_chunk':
        bus.emitStream({ type: 'first_chunk', requestId, atMs: ev.atMs });
        break;
      case 'stream_error':
        bus.emitStream({ type: 'stream_error', requestId, frame: ev.frame });
        break;
      case 'aborted':
        bus.emitStream({ type: 'aborted', requestId, reason: ev.reason });
        break;
      case 'done': {
        const usage: Usage | null =
          ev.usage !== null && ev.usage !== undefined ? normalizeUsage(ev.usage) : null;
        bus.emitTerminal({
          type: 'success',
          requestId,
          channelKey,
          usage: usage ?? undefined,
          durationMs: Date.now() - startedAt,
          terminated: ev.terminated,
          bytesRelayed: ev.bytesRelayed,
          outputFeatures: ev.outputFeatures,
          doneSentinel: ev.doneSentinel,
          terminalFrame: ev.terminalFrame,
        });
        break;
      }
    }
  });
}

export { emitTo };
