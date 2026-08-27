/**
 * 幂等操作契约（纯函数）：
 * operationId 是调用方设计责任；命令指纹 = 规范化 JSON（键排序 + 丢弃 undefined）的 SHA-256。
 * 渠道资金用例共用此口径。
 */
import { createHash } from 'node:crypto';
import { controlPlaneErrors } from '../errors';

/** 1-128 字符，字母数字开头，允许 . _ : -（禁 / 等路径语义字符） */
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function assertOperationId(operationId: string): void {
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw controlPlaneErrors.business('invalid_operation_id', { operationId });
  }
}

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | CanonicalObject;
/** canonical JSON 输入形状（键排序 + 丢弃 undefined 的对象树） */
export interface CanonicalObject {
  readonly [key: string]: CanonicalValue | undefined;
}

function canonicalize(value: CanonicalValue | undefined): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter((entry) => entry[1] !== undefined)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

/** 命令指纹（幂等身份的稳定表示）：等价的规范化命令产生相同摘要 */
export function commandFingerprint(kind: string, payload: CanonicalObject): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize({ kind, ...payload })))
    .digest('hex');
}
