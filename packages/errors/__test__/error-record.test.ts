import { describe, expect, it } from 'vitest';

import { type ErrorCategory } from '../src/category';
import { defineErrorCatalog } from '../src/definition';
import {
  MAX_CAUSE_DEPTH,
  ROOT_ERROR_CODES,
  handlingOf,
  recordOf,
  recordOfUnknown,
  type ErrorRecord,
} from '../src/error-record';
import { BusinessError, DefectError, InfrastructureError } from '../src/nature';

/** 错误即数据：记录字段映射、处理语义单点派生、cause 链规范化（含深度上限） */

const MatrixErrors = defineErrorCatalog('matrix', {
  invalid_input: { category: 'invalid_input', message: 'bad input', zh: '输入有误' },
  not_found: { category: 'not_found', message: 'not found', zh: '未找到' },
  conflict: { category: 'conflict', message: 'conflict', zh: '冲突' },
  forbidden: { category: 'forbidden', message: 'forbidden', zh: '不允许' },
  quota_exhausted: { category: 'quota_exhausted', message: 'quota exhausted', zh: '额度耗尽' },
  rate_limited: { category: 'rate_limited', message: 'rate limited', zh: '限流' },
  unavailable: { category: 'unavailable', message: 'unavailable', zh: '不可用' },
});

describe('recordOf：三性记录映射', () => {
  it('business 记录必带 category；字段全量映射', () => {
    const e = new BusinessError(
      MatrixErrors.entry('quota_exhausted'),
      { needed: 5 },
      { retryAfterMs: 250 },
    );
    const r = recordOf(e);
    expect(r).toEqual({
      nature: 'business',
      category: 'quota_exhausted',
      code: 'matrix.quota_exhausted',
      message: 'quota exhausted',
      context: { needed: 5 },
      retryAfterMs: 250,
      cause: undefined,
    });
  });

  it('infrastructure / defect 记录无 category 字段', () => {
    const infra = recordOf(new InfrastructureError('db down', 'runtime.db'));
    const defect = recordOf(
      new DefectError('invariant', 'billing.invariant', { table: 'entries' }),
    );
    expect(infra.nature).toBe('infrastructure');
    expect('category' in infra).toBe(false);
    expect(defect.nature).toBe('defect');
    expect('category' in defect).toBe(false);
    expect(defect.context).toEqual({ table: 'entries' });
  });
});

describe('handlingOf：处理语义单点派生（全矩阵）', () => {
  const matrix: ReadonlyArray<[ErrorCategory, boolean, boolean]> = [
    ['invalid_input', false, false],
    ['not_found', false, false],
    ['conflict', false, false],
    ['forbidden', false, false],
    ['quota_exhausted', false, false],
    ['rate_limited', true, false],
    ['unavailable', true, true],
  ];

  it.each(matrix)('business/%s → retryable=%s alert=%s', (category, retryable, alert) => {
    const record = recordOf(MatrixErrors.business(category));
    expect(handlingOf(record)).toEqual({ retryable, alert });
  });

  it('infrastructure → 可重试且告警；defect → 不重试且响铃', () => {
    expect(handlingOf(recordOf(new InfrastructureError('m', 'a.b')))).toEqual({
      retryable: true,
      alert: true,
    });
    expect(handlingOf(recordOf(new DefectError('m', 'a.b')))).toEqual({
      retryable: false,
      alert: true,
    });
  });
});

describe('cause 链规范化', () => {
  it('嵌套根类错误：逐层成录并保留各自性质', () => {
    const root = MatrixErrors.business('quota_exhausted');
    const outer = new InfrastructureError('settlement failed', 'billing.settle', undefined, {
      cause: root,
    });
    const r = recordOf(outer);
    expect(r.nature).toBe('infrastructure');
    expect(r.cause).toMatchObject({
      nature: 'business',
      category: 'quota_exhausted',
      code: 'matrix.quota_exhausted',
    });
  });

  it('外来 Error 作 cause：按缺陷 errors.unhandled 成录，name 进 context', () => {
    const pg = Object.assign(new Error('duplicate key'), { name: 'PostgresError' });
    const e = new BusinessError(MatrixErrors.entry('conflict'), undefined, { cause: pg });
    const r = recordOf(e);
    expect(r.cause?.nature).toBe('defect');
    expect(r.cause?.code).toBe(ROOT_ERROR_CODES.unhandled);
    expect(r.cause?.message).toBe('duplicate key');
    expect(r.cause?.context).toEqual({ name: 'PostgresError' });
  });

  it('非错误值作 cause：按缺陷 errors.non_error 成录', () => {
    const e = new DefectError('bad throw', 'app.somewhere', undefined, { cause: 'boom' });
    expect(recordOf(e).cause).toEqual({
      nature: 'defect',
      code: ROOT_ERROR_CODES.nonError,
      message: 'boom',
    });
  });

  it('深度上限：病态长链截断为根 + MAX_CAUSE_DEPTH 层', () => {
    let deepest = new Error('depth-0');
    for (let i = 1; i <= 30; i += 1) {
      deepest = new Error(`depth-${i}`, { cause: deepest });
    }
    let node: ErrorRecord | undefined = recordOfUnknown(deepest);
    let depth = 0;
    while (node?.cause !== undefined) {
      node = node.cause;
      depth += 1;
    }
    expect(depth).toBe(MAX_CAUSE_DEPTH);
  });
});
