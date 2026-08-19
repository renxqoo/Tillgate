/** billing 死单复核操作错误（S5 重写后唯一出处；自旧 operations.ts 迁出） */
export class BillingOperationError extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'state_conflict'
      | 'idempotency_conflict'
      | 'invalid_receipt',
  ) {
    super(code);
    this.name = 'BillingOperationError';
  }
}
