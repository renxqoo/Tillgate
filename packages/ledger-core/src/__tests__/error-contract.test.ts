/** 错误契约：全部错误类型化、code 全局唯一、name 可判别（边界层按 code 翻译 HTTP 的前提） */
import { describe, expect, it } from 'vitest';
import * as errors from '../errors';
import { LedgerCoreError } from '../errors';

describe('错误契约', () => {
  const instances: Array<{ name: string; code: string; error: LedgerCoreError }> = [
    { name: 'InvalidInputError', code: 'invalid_input', error: new errors.InvalidInputError('field', 'detail') },
    { name: 'UnknownOperationKindError', code: 'unknown_operation_kind', error: new errors.UnknownOperationKindError('x', ['a.b']) },
    { name: 'InvalidOperationIdError', code: 'invalid_operation_id', error: new errors.InvalidOperationIdError('bad id') },
    { name: 'OperationConflictError', code: 'operation_conflict', error: new errors.OperationConflictError('op', 'fingerprint_mismatch', 'a.b', 'c.d') },
    { name: 'LedgerInternalError', code: 'ledger_internal', error: new errors.LedgerInternalError('op', 'detail') },
  ];

  it('每个错误都是 LedgerCoreError 实例且 name/code 与声明一致', () => {
    for (const { name, code, error } of instances) {
      expect(error).toBeInstanceOf(LedgerCoreError);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe(name);
      expect(error.code).toBe(code);
      expect(error.message.length).toBeGreaterThan(0);
    }
  });

  it('code 全局唯一（边界层 switch(code) 的前提）', () => {
    const codes = instances.map((i) => i.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('结构化字段（allowed/reason/storedKind/detail 供 HTTP 翻译）', () => {
    expect(new errors.UnknownOperationKindError('x', ['a.b', 'c.d']).allowed).toEqual(['a.b', 'c.d']);
    const conflict = new errors.OperationConflictError('op-1', 'kind_mismatch', 'a.b', 'c.d');
    expect(conflict.reason).toBe('kind_mismatch');
    expect(conflict.storedKind).toBe('a.b');
    expect(conflict.requestedKind).toBe('c.d');
    expect(new errors.InvalidInputError('limit', 'must be 1-200').detail).toBe('must be 1-200');
  });
});
