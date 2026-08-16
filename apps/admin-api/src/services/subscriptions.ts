import { LedgerError, LEDGER_HTTP } from '@ai-gateway/ledger';
import { HttpError, type KnownErrorCode } from '@ai-gateway/http';

/**
 * 套餐/订阅 ledger 业务错误 → HTTP（映射表单一真相：packages/ledger error-catalog）。
 */
export function mapSubscriptionError(error: unknown): HttpError {
  if (error instanceof LedgerError) {
    const m = LEDGER_HTTP[error.code];
    return new HttpError(m.code as KnownErrorCode, error.message || m.message);
  }
  throw error;
}
