/**
 * 告警投递 job（驱动壳）：单轮算法（认领→订阅过滤→并行投递→CAS 进度/退避）
 * 在 notifications dispatchOnce；本文件只提供节奏入口。静音开关
 * （WORKER_NOTIFY_ENABLED=false）在装配层决定是否注册本 job。
 */
import type { DispatchResult } from '@tillgate/notifications';

type NotifyJob = () => Promise<DispatchResult>;

export function createNotifyJob(deps: { dispatchOnce: () => Promise<DispatchResult> }): NotifyJob {
  return async function runNotifyDispatch() {
    return await deps.dispatchOnce();
  };
}
