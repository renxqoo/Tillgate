/**
 * 准入判定（从 create-ai 的 chat/chatStream 去重提取）：
 * 熔断 open → 拒绝；死凭据 invalid → 拒绝（渠道停止路由，等人工换 Key）。
 * 返回错误时由调用方按各自路径收敛（非流式 emit failed + 错误结果；
 * 流式 failEarlyStream 的 emitTerminal）。
 */
import type { CircuitBreaker } from '../breaker/breaker';
import type { DeadCredentialTracker } from '../dead-credential/tracker';
import { circuitOpenError, deadCredentialError } from '../errors/internal';
import type { UpstreamError } from '../types';

export interface AdmissionDeps {
  breaker: CircuitBreaker;
  credential: DeadCredentialTracker;
  requestId: string;
  key: string;
  log: { error: (msg: string, ...args: unknown[]) => void };
}

export async function admitRequest(deps: AdmissionDeps): Promise<UpstreamError | null> {
  if (!(await deps.breaker.canRequest())) {
    deps.log.error(`[ai] ${deps.requestId} circuit open, rejected (${deps.key})`);
    return circuitOpenError();
  }
  if (!(await deps.credential.canRequest())) {
    deps.log.error(`[ai] ${deps.requestId} dead credential, rejected (${deps.key})`);
    return deadCredentialError();
  }
  return null;
}
