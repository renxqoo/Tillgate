import type {
  StreamError,
  TerminationReason,
  TextTokenFeatures,
  UpstreamError,
  Usage,
} from './types';

/**
 * AiEvent 判别联合（观察面契约——计费/审计/trace/渠道健康四类订阅者的唯一输入）。
 *
 * 事件顺序约定（同一次调用）：
 *   - 非流式：attempt_start* → [param_adjustment] → (success | (empty_completion | failed))
 *   - 流式：attempt_start* → [param_adjustment] → first_chunk（一次性，TTFB 权威锚点）
 *     → [stream_error…] → [aborted?] → success（done/success 一定最后发出）
 *
 * 计费语义（requirements 5.11）：
 *   - usage 是 success 终态的随行状态：任何帧带的非 null usage 均视为累计值，
 *     最新者胜出（scanner 逐帧捕获，随 done/success 事件一次性流出——独立 'usage'
 *     流事件已按死代码裁决移除：包内零生产、inference 零消费，见 IMPLEMENTATION §3.3）
 *   - success.terminated !== undefined → 流式中断，网关标 stream_aborted
 *   - 中断且 success.usage 为空 → 账务进入 uncertain，禁止把未知缓存命中估成 0 后直接扣费
 *     （中断但有可信累计 usage → 按最新 usage 正常结算）
 *
 * 回调契约：fire-and-forget——观察者异常被吞（不反噬数据面）、不得阻塞、不得做 IO
 * （重活入队，outbox 侧消费）；回调必须微秒级（并发预算见 IMPLEMENTATION.md §3.1）。
 */
export type AiEvent =
  | { type: 'attempt_start'; requestId: string; channelKey: string; attempt: number; atMs: number }
  /** TTFB 权威观察点：上游首字节流向客户端（一次性）；晚订阅消费方在此锚定首字节时刻 */
  | { type: 'first_chunk'; requestId: string; atMs: number }
  | {
      type: 'param_adjustment';
      requestId: string;
      param: string;
      action: 'ignore' | 'clamp' | 'map';
      from?: unknown;
      to?: unknown;
    }
  | { type: 'stream_error'; requestId: string; frame: StreamError }
  | { type: 'aborted'; requestId: string; reason: TerminationReason }
  | { type: 'failed'; requestId: string; channelKey: string; error: UpstreamError }
  | { type: 'empty_completion'; requestId: string; channelKey: string; attempt: number }
  | {
      type: 'success';
      requestId: string;
      /** 渠道维度（多候选循环时区分哪个渠道成功） */
      channelKey: string;
      usage?: Usage;
      durationMs: number;
      /** 流式正常结束 = undefined；中断结束 = 中断原因（中断计费路径依据） */
      terminated?: TerminationReason;
      /** 已透传给客户端的字节数（仅流式；取消且 usage 缺失时的估算佐证） */
      bytesRelayed?: number;
      /**
       * 输出内容特征四计数器（仅流式；替代 v1 outputText 文本累积——O(1) 内存，
       * 估算层充分统计量）。usage 缺失或取消时估算输出 token 的数据源。
       */
      outputFeatures?: TextTokenFeatures;
      /** [DONE] 哨兵是否到达（区分自然完成与终止后断开） */
      doneSentinel?: boolean;
      /** 终止帧（finish_reason）是否到达 */
      terminalFrame?: boolean;
      /** 静默溢出旗标（可观测信号，不翻转成功语义）；溢出时的模型名随行 */
      contextOverflow?: boolean;
      model?: string;
    };
