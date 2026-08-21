/** 幂等操作内核错误类型（错误语义分级：输入非法 ≠ 幂等冲突 ≠ 词表越界 ≠ 内部不变量） */

export class LedgerCoreError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'LedgerCoreError';
  }
}

/** 运行时输入非法（字段级定位；调用方 bug，不应重试） */
export class InvalidInputError extends LedgerCoreError {
  constructor(
    readonly field: string,
    readonly detail: string,
  ) {
    super(`invalid ${field}: ${detail}`, 'invalid_input');
    this.name = 'InvalidInputError';
  }
}

/** 操作类型不在白名单（fail-closed；allowed 携带全部合法值） */
export class UnknownOperationKindError extends LedgerCoreError {
  constructor(
    readonly kind: string,
    readonly allowed: readonly string[],
  ) {
    super(`unknown operation kind '${kind}' (allowed: ${allowed.join(', ') || 'none'})`, 'unknown_operation_kind');
    this.name = 'UnknownOperationKindError';
  }
}

/** operationId 形状非法（推荐 'domain.subject:业务键' 风格） */
export class InvalidOperationIdError extends LedgerCoreError {
  constructor(value: unknown) {
    super(`operation id must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$, got ${JSON.stringify(value)}`, 'invalid_operation_id');
    this.name = 'InvalidOperationIdError';
  }
}

/**
 * 幂等键冲突：同一 operationId 已按「不同指纹 / 不同类型」执行过。
 * 这是串号事故的最后一道闸——没有它，同键不同参的重放会把别人的回执当自己的结果返回。
 */
export class OperationConflictError extends LedgerCoreError {
  constructor(
    readonly operationId: string,
    readonly reason: 'kind_mismatch' | 'fingerprint_mismatch',
    readonly storedKind: string,
    readonly requestedKind: string,
  ) {
    super(
      `operation '${operationId}' ${reason === 'kind_mismatch' ? 'has a different kind' : 'was executed with a different fingerprint'} (stored '${storedKind}', requested '${requestedKind}')`,
      'operation_conflict',
    );
    this.name = 'OperationConflictError';
  }
}

/** 防御点兜底：唯一冲突读回缺行、提交后回执缺位等「不可能分支」——亮红灯而非静默 */
export class LedgerInternalError extends LedgerCoreError {
  constructor(
    readonly operation: string,
    detail: string,
  ) {
    super(`internal invariant broken at ${operation}: ${detail}`, 'ledger_internal');
    this.name = 'LedgerInternalError';
  }
}
