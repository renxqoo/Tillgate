/**
 * 同渠道重试预算耗尽标记（deadline 语义）：withRetry 的总预算到点时 abort
 * 在途上游请求，abort reason 携带本标记。传输层据此把终态归类为「上游超时」
 * （kind=timeout，可换渠 + 熔断计数），而非与客户端取消混用的 canceled
 * （canceled 不换渠道、跳过同候选其余渠道）——慢上游必须让位给备用渠道。
 * 与 ServerDrainAbort 同构：标记类型 + 判定函数，分类点在 signal.aborted 之前消费。
 */
export class RetryDeadlineAbort extends Error {
  readonly retryDeadline = true;
  constructor(message = 'retry deadline exceeded') {
    super(message);
    this.name = 'RetryDeadlineAbort';
  }
}

/** 判定 abort 信号是否为重试预算耗尽中止（null = 非该类中止） */
export function asRetryDeadlineAbort(reason: unknown): RetryDeadlineAbort | null {
  return reason instanceof RetryDeadlineAbort ? reason : null;
}
