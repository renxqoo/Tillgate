/**
 * 共享错误家谱（跨域公共语义）——首两个成员：幂等操作。
 */
export class OperationIdInvalidError extends Error {
  constructor(public readonly operationId: string) {
    super(`invalid operation id: ${operationId}`);
    this.name = 'OperationIdInvalidError';
  }
}

/** 同 operationId 不同命令（规范化指纹不等）→ 409 语义 */
export class OperationConflictError extends Error {
  constructor(public readonly operationId: string) {
    super(`idempotency conflict on operation ${operationId}`);
    this.name = 'OperationConflictError';
  }
}
