export interface RequestBudget {
  signal: AbortSignal;
  deadlineAt: number;
  remainingMs(): number;
  dispose(): void;
}

/** 统一管理客户端取消、请求绝对 deadline 和服务 drain。 */
export class RequestLifecycle {
  private readonly draining = new AbortController();

  constructor(private readonly deadlineMs: number) {}

  create(clientSignal: AbortSignal): RequestBudget {
    const deadline = AbortSignal.timeout(this.deadlineMs);
    const signal = AbortSignal.any([clientSignal, deadline, this.draining.signal]);
    const deadlineAt = Date.now() + this.deadlineMs;
    return {
      signal,
      deadlineAt,
      remainingMs: () => Math.max(1, deadlineAt - Date.now()),
      dispose: () => {},
    };
  }

  beginDrain(): void {
    if (!this.draining.signal.aborted) this.draining.abort(new Error('gateway draining'));
  }

  get isDraining(): boolean {
    return this.draining.signal.aborted;
  }
}
