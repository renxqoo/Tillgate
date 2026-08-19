/** kinds 白名单守卫与 operationId 形状（fail-closed：进 DB 前一律拒绝） */
import { InvalidInputError, InvalidOperationIdError, UnknownOperationKindError } from './errors.js';

/** kinds 白名单（createLedger 时构建，运行期只读） */
export interface ValidationGuards {
  kinds: ReadonlySet<string>;
}

/** 词表符号（kind 共用）：小写 snake/kebab，2-32 位 */
export const KIND_VOCAB_RE = /^[a-z][a-z0-9._-]{1,31}$/;

export const OPERATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function buildGuards(kinds: readonly string[]): ValidationGuards {
  return { kinds: new Set(kinds) };
}

export function guardKind(kind: string, guards: ValidationGuards): string {
  if (typeof kind !== 'string' || !KIND_VOCAB_RE.test(kind)) {
    throw new InvalidInputError('kind', `must match ${KIND_VOCAB_RE.source}`);
  }
  if (!guards.kinds.has(kind)) {
    throw new UnknownOperationKindError(kind, [...guards.kinds]);
  }
  return kind;
}

export function assertOperationId(operationId: unknown): string {
  if (typeof operationId !== 'string' || !OPERATION_ID_RE.test(operationId)) {
    throw new InvalidOperationIdError(operationId);
  }
  return operationId;
}
