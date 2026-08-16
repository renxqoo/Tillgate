import { ServerDrainAbort } from '@ai-gateway/ai';

export interface RequestBudget {
  signal: AbortSignal;
  deadlineAt: number;
  remainingMs(): number;
  dispose(): void;
}

/** drain 期间新请求的拒绝信号（steps/admission 翻译为 503 server_draining） */
export class ServiceDrainingError extends Error {
  constructor() {
    super('gateway draining');
    this.name = 'ServiceDrainingError';
  }
}

/**
 * 统一管理客户端取消、请求绝对 deadline 和服务 drain。
 *
 * drain 语义（H2，单一真相）：
 *   - beginDrain() 只「拒绝新请求」——draining 置位后 create() 抛
 *     ServiceDrainingError；此前已创建的 budget 不受影响，在途请求跑到
 *     自然结束或自身 deadline。
 *   - 宽限期（abortInFlightAfterMs）结束后才 abort 在途 budget，abort
 *     reason 携带 ServerDrainAbort 标记——计费侧据此归类服务端责任
 *     （全额释放），而非用户取消（估算结算）。
 */
export interface RequestLifecycle {
  create(clientSignal: AbortSignal): RequestBudget;
  /** 停止接收新请求；abortInFlightAfterMs 后中止在途请求（服务端责任标记） */
  beginDrain(abortInFlightAfterMs: number): void;
  readonly isDraining: boolean;
}

export function createRequestLifecycle(deadlineMs: number): RequestLifecycle {
  const draining = new AbortController();
  const drainAbort = new AbortController();

  return {
    create(clientSignal: AbortSignal): RequestBudget {
      if (draining.signal.aborted) throw new ServiceDrainingError();
      const deadline = AbortSignal.timeout(deadlineMs);
      const signal = AbortSignal.any([clientSignal, deadline, drainAbort.signal]);
      const deadlineAt = Date.now() + deadlineMs;
      return {
        signal,
        deadlineAt,
        remainingMs: () => Math.max(1, deadlineAt - Date.now()),
        dispose: () => {},
      };
    },

    beginDrain(abortInFlightAfterMs: number): void {
      if (draining.signal.aborted) return;
      draining.abort(new Error('gateway draining'));
      const timer = setTimeout(
        () => drainAbort.abort(new ServerDrainAbort()),
        abortInFlightAfterMs,
      );
      timer.unref?.();
    },

    get isDraining(): boolean {
      return draining.signal.aborted;
    },
  };
}
