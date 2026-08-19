/** 观测包装：onOperation 异常绝不影响业务结果或业务错误 */
import type { WalletOperation, WalletTelemetry } from './types';
import { WalletError } from './errors';

export async function observe<T>(
  telemetry: WalletTelemetry | undefined,
  operation: WalletOperation,
  call: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    const result = await call();
    try {
      const replayed =
        typeof result === 'object' && result !== null && 'replayed' in result
          ? Boolean((result as { replayed?: boolean }).replayed)
          : undefined;
      telemetry?.onOperation?.({
        operation,
        outcome: 'success',
        durationMs: performance.now() - started,
        ...(replayed === undefined ? {} : { replayed }),
      });
    } catch {
      // 观测系统不可影响业务结果。
    }
    return result;
  } catch (error) {
    try {
      telemetry?.onOperation?.({
        operation,
        outcome: 'error',
        durationMs: performance.now() - started,
        errorCode: error instanceof WalletError ? error.code : 'unknown_error',
      });
    } catch {
      // 观测系统不可影响业务错误。
    }
    throw error;
  }
}
