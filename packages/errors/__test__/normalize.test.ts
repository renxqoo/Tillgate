import { describe, expect, it } from 'vitest';

import { defineErrorCatalog } from '../src/definition';
import { normalizeError } from '../src/normalize';
import { ROOT_ERROR_CODES, recordOf } from '../src/error-record';
import { DefectError, InfrastructureError } from '../src/nature';

const NormalizeErrors = defineErrorCatalog('normtest', {
  denied: { category: 'conflict', message: 'denied', zh: '拒绝' },
});

/** 边界兜底：任意 unknown → 记录；外来一律按缺陷（v1「未知一律按缺陷」语义的通用化） */
describe('normalizeError', () => {
  it('根契约错误 → 与 recordOf 等价（三性各一）', () => {
    const samples = [
      NormalizeErrors.business('denied', { x: 1 }),
      new InfrastructureError('down', 'a.b'),
      new DefectError('broken', 'a.b'),
    ];
    for (const e of samples) {
      expect(normalizeError(e)).toEqual(recordOf(e));
    }
  });

  it('外来 Error → errors.unhandled：message 保留、name 进 context、cause 链跟随', () => {
    const inner = new Error('inner');
    const outer = new Error('outer', { cause: inner });
    const r = normalizeError(outer);
    expect(r.nature).toBe('defect');
    expect(r.code).toBe(ROOT_ERROR_CODES.unhandled);
    expect(r.message).toBe('outer');
    expect(r.context).toEqual({ name: 'Error' });
    expect(r.cause?.message).toBe('inner');
    expect(r.cause?.code).toBe(ROOT_ERROR_CODES.unhandled);
  });

  it('空 message 的外来 Error：回退到 name；name 也为空回退到通用文案', () => {
    const fallbackName = new Error('');
    const r1 = normalizeError(fallbackName);
    expect(r1.message).toBe('Error'); // name 默认值

    const anonymous = new Error('');
    anonymous.name = '';
    const r2 = normalizeError(anonymous);
    expect(r2.message).toBe('unknown error');
  });

  it('非错误值 → errors.non_error，安全字符串化（含 Symbol/对象/null）', () => {
    expect(normalizeError('boom')).toMatchObject({
      code: ROOT_ERROR_CODES.nonError,
      message: 'boom',
    });
    expect(normalizeError(42)).toMatchObject({ code: ROOT_ERROR_CODES.nonError, message: '42' });
    expect(normalizeError({ a: 1 })).toMatchObject({
      code: ROOT_ERROR_CODES.nonError,
      message: '[object Object]',
    });
    expect(normalizeError(null)).toMatchObject({
      code: ROOT_ERROR_CODES.nonError,
      message: 'null',
    });
    expect(normalizeError(undefined)).toMatchObject({
      code: ROOT_ERROR_CODES.nonError,
      message: 'undefined',
    });
    expect(normalizeError(Symbol('x'))).toMatchObject({
      code: ROOT_ERROR_CODES.nonError,
      message: 'Symbol(x)',
    });
  });

  it('toString 抛错的病态对象不得让归一自身失败', () => {
    const evil = {
      toString(): string {
        throw new Error('nope');
      },
    };
    expect(normalizeError(evil)).toMatchObject({
      code: ROOT_ERROR_CODES.nonError,
      message: '[unstringifiable]',
    });
  });
});
