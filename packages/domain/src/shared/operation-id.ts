/**
 * operationId 契约（幂等键是调用方设计责任）：
 * 1-128 字符，字母数字开头，允许 . _ : -（禁 / 等路径语义字符）。
 */
import { OperationIdInvalidError } from './errors.js';

const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function assertOperationId(operationId: string): void {
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw new OperationIdInvalidError(operationId);
  }
}
