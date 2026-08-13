import type { StreamError, UpstreamError, Usage } from './types.js';

/**
 * 调用全生命周期事件（gateway 消费：转计量事件 / 驱动候选循环 / 标 stream_aborted）。
 *
 * 事件顺序约定（同一次调用）：
 *   - 非流式：attempt_start* → [param_adjustment] → (success | (empty_completion | failed))
 *   - 流式：attempt_start* → [param_adjustment] → success
 *     （流内中断：aborted → success(terminated) ；流内错误帧：stream_error*）
 *   - done/success 一定最后发出（relay-stream 保证流尾事件顺序）
 *
 * 计费语义（requirements 5.11）：
 *   - success.terminated !== undefined → 流式中断，gateway 标 stream_aborted=true
 *   - 中断且 success.usage 为空 → 账务进入 uncertain，禁止把未知缓存命中估成 0 后直接扣费
 *   - 正常结束但 success.usage 为空 → gateway 按已透字节估算 tokens（口径同非流式 estimate）
 */
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
      reason:
        | 'client_disconnect'
        | 'request_cancelled'
        | 'inactivity'
        | 'upstream_error'
        | 'upstream_disconnected'
        | 'upstream_truncated';
    }
  | { type: 'failed'; requestId: string; channelKey: string; error: UpstreamError }
  | { type: 'empty_completion'; requestId: string; channelKey: string; attempt: number }
  | {
      type: 'success';
      requestId: string;
      /** 渠道维度（gateway 多候选循环时区分哪个渠道成功/失败） */
      channelKey: string;
      usage?: Usage;
      durationMs: number;
      /**
       * 流式正常结束 = undefined；中断结束 = 中断原因。
       * gateway 据此标 stream_aborted 并走中断计费路径（5.11）。
       */
      terminated?:
        | 'client_disconnect'
        | 'request_cancelled'
        | 'inactivity'
        | 'upstream_error'
        | 'upstream_disconnected'
        | 'upstream_truncated';
      /**
       * 已透传给客户端的字节数（仅流式有意义）。
       * usage 缺失时 gateway 按 bytesRelayed / charPerToken 估算 tokens。
       */
      bytesRelayed?: number;
    };
