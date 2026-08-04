import type { StreamError, Usage, UpstreamError } from './types.js';

/** 调用全生命周期事件（gateway 消费：转计量事件 / 驱动候选循环） */
export type AiEvent =
  | { type: 'attempt_start'; requestId: string; channelKey: string; attempt: number }
  | {
      type: 'param_adjustment';
      requestId: string;
      param: string;
      action: 'ignore' | 'clamp' | 'map';
      from?: unknown;
      to?: unknown;
    }
  | { type: 'usage'; requestId: string; usage: Usage; streamError?: StreamError }
  | { type: 'stream_error'; requestId: string; frame: StreamError }
  | {
      type: 'aborted';
      requestId: string;
      reason: 'client_disconnect' | 'inactivity' | 'deadline';
    }
  | { type: 'failed'; requestId: string; error: UpstreamError }
  | { type: 'empty_completion'; requestId: string; attempt: number }
  | { type: 'success'; requestId: string; usage?: Usage; durationMs: number };
