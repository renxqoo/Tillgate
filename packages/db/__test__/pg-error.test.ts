/**
 * PG 错误分类:全 cause 链探测、精确码判定、约束名提取。
 * 含回归用例:深度 4 的唯一冲突(23505)必须检出。
 */
import { describe, expect, it } from 'vitest';
import {
  pgSqlState,
  isUniqueViolation,
  uniqueViolationConstraint,
  transientTxFailureCode,
} from '../src/pg-error.js';

/** 模拟 pg 库错误形态:{ code, constraint? } 的 Error */
function pgLike(code: string, constraint?: string): Error {
  return Object.assign(new Error(`pg error ${code}`), constraint ? { code, constraint } : { code });
}

/** 把错误包进 depth 层 Error cause 链(drizzle 的包装方式) */
function wrap(error: unknown, depth: number): Error {
  let cur: Error = new Error('drizzle-wrap-1', { cause: error });
  for (let i = 2; i <= depth; i += 1) cur = new Error(`drizzle-wrap-${i}`, { cause: cur });
  return cur;
}

describe('pgSqlState(任意 5 位 SQLSTATE,全链)', () => {
  it.each([
    ['直接持有(深度 0)', 0],
    ['包装 1 层', 1],
    ['包装 3 层', 3],
    ['包装 5 层', 5],
    ['包装 10 层', 10],
  ])('%s 可检出', (_name, depth) => {
    expect(pgSqlState(wrap(pgLike('23505'), depth))).toBe('23505');
  });

  it('非 5 位/小写/数字混合不匹配', () => {
    expect(pgSqlState(pgLike('2350'))).toBeNull();
    expect(pgSqlState(pgLike('235055'))).toBeNull();
    expect(pgSqlState(pgLike('23505x'))).toBeNull();
    expect(pgSqlState(pgLike('40p01'))).toBeNull(); // 小写不算 SQLSTATE
  });

  it('R-4 回归:系统 errno 串(code/errno 双字段)不再被 5 位词形误判为 SQLSTATE', () => {
    // pg 的连接层错误挂 code('EPIPE');Bun SQL 挂 errno('EPERM'/'ELOOP')
    // ——纯字母 5 位串曾被 /^[0-9A-Z]{5}$/ 误收,污染 pgSqlState 返回契约
    expect(pgSqlState(pgLike('EPERM'))).toBeNull();
    expect(pgSqlState(pgLike('ELOOP'))).toBeNull();
    expect(pgSqlState(pgLike('EPIPE'))).toBeNull();
    expect(pgSqlState(pgLike('EACCES'))).toBeNull();
    expect(
      pgSqlState(Object.assign(new Error('bun sql connect failed'), { errno: 'EPERM' })),
    ).toBeNull();
    expect(
      pgSqlState(Object.assign(new Error('bun sql too many symlinks'), { errno: 'ELOOP' })),
    ).toBeNull();
  });

  it('含数字的字母类开头 SQLSTATE(HV/P0/XX 族)仍可检出', () => {
    expect(pgSqlState(pgLike('HV00N'))).toBe('HV00N');
    expect(pgSqlState(pgLike('P0002'))).toBe('P0002');
    expect(pgSqlState(pgLike('XX001'))).toBe('XX001');
  });

  it('code 非字符串 / 无 code / null 输入 / 链尾终止', () => {
    expect(pgSqlState(new Error('plain'))).toBeNull();
    expect(pgSqlState(Object.assign(new Error('num'), { code: 23505 }))).toBeNull();
    expect(pgSqlState(null)).toBeNull();
    // 参数可选:缺省调用与显式 undefined 同为空链(签名可选化,no-useless-undefined 与 typecheck 双过)
    expect(pgSqlState()).toBeNull();
    expect(pgSqlState('string error')).toBeNull();
  });
});

describe('isUniqueViolation(23505)', () => {
  it('直接与深层包装均可判定', () => {
    expect(isUniqueViolation(pgLike('23505'))).toBe(true);
    expect(isUniqueViolation(wrap(pgLike('23505'), 2))).toBe(true);
  });

  it('B3 回归:深度 4 的 23505 必须检出(v1 wallet 深度 3 实现会漏)', () => {
    expect(isUniqueViolation(wrap(pgLike('23505'), 4))).toBe(true);
    expect(isUniqueViolation(wrap(pgLike('23505'), 7))).toBe(true);
  });

  it('其他 SQLSTATE / 普通错误不为唯一冲突', () => {
    expect(isUniqueViolation(pgLike('23503'))).toBe(false);
    expect(isUniqueViolation(pgLike('40P01'))).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
  });
});

describe('uniqueViolationConstraint(约束名提取)', () => {
  it('返回被撞的约束名(含深层包装)', () => {
    const err = wrap(pgLike('23505', 'users_issuer_subject_uq'), 3);
    expect(uniqueViolationConstraint(err)).toBe('users_issuer_subject_uq');
  });

  it('是唯一冲突但 PG 未给约束名 → null(v1 identity-core 此处给 "",语义收敛为 null)', () => {
    expect(uniqueViolationConstraint(pgLike('23505'))).toBeNull();
  });

  it('非唯一冲突 → null', () => {
    expect(uniqueViolationConstraint(pgLike('40P01'))).toBeNull();
    expect(uniqueViolationConstraint(new Error('x'))).toBeNull();
  });
});

describe('transientTxFailureCode(40P01 / 40001)', () => {
  it('死锁与串行化失败均可检出(深层包装)', () => {
    expect(transientTxFailureCode(pgLike('40P01'))).toBe('40P01');
    expect(transientTxFailureCode(wrap(pgLike('40001'), 4))).toBe('40001');
  });

  it('其他错误 → null(重试的唯一触发条件)', () => {
    expect(transientTxFailureCode(pgLike('23505'))).toBeNull();
    expect(transientTxFailureCode(new Error('connection reset'))).toBeNull();
  });
});
