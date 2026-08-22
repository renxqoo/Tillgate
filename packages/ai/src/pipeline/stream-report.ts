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
  const callCbs: Array<(e: AiEvent) => void> = [];
  let globalBound = false;
  const push = (e: AiEvent): void => {
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
    for (const e of terminalBuffer.slice()) {
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
        for (const e of terminalBuffer.slice()) {
          try {
            cb(e);
          } catch {
            /* 重放异常忽略 */
          }
        }
        if (!globalBound) {
          globalBound = true;
        }
      },
    }),
  };
  return bus;
}

/** 流开始前失败的早退流（含 OpenAI 兼容错误帧 + failed 终态） */
export function failEarlyStream(
  bus: StreamEventBus,
  error: UpstreamError,
  requestId: string,
  channelKey: string,
): ChatStreamResult {
  bus.emitTerminal({ type: 'failed', requestId, channelKey, error });
  const frame = `data: ${JSON.stringify({ error: { code: error.kind, type: error.vendorCode, message: error.message } })}\n\n`;
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
        const usage: Usage | null = ev.usage !== null && ev.usage !== undefined ? normalizeUsage(ev.usage) : null;
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
