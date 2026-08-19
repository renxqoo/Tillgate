/**
 * 命令指纹（幂等身份的稳定表示）：等价的规范化命令产生相同摘要。
 * canonical JSON = 键排序（localeCompare）+ 丢弃 undefined；SHA-256。
 * 同键不同命令 → IdempotencyConflictError；存储 NULL 仅历史行兼容。
 */
import { createHash } from 'node:crypto';
import { IdempotencyConflictError } from './errors.js';

type CanonicalValue = null | boolean | number | string | readonly CanonicalValue[] | CanonicalObject;
type CanonicalObject = { readonly [key: string]: CanonicalValue | undefined };

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

export function commandFingerprint(kind: string, payload: CanonicalObject): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize({ kind, ...payload })))
    .digest('hex');
}

export function assertCommandFingerprint(
  stored: string | null,
  expected: string,
  refType: string,
  refId: string,
  kind: string,
): void {
  if (stored !== null && stored !== expected) {
    throw new IdempotencyConflictError(refType, refId, kind);
  }
}
