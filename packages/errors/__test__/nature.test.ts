import { describe, expect, it } from 'vitest';

import {
  BusinessError,
  DefectError,
  InfrastructureError,
  TokenlensError,
  type ErrorContext,
} from '../src/nature';

/**
 * 三性根类契约——v1 三份 error-contract.test（identity-core/wallet/ledger-core）不变量的
 * 通用化：instanceof 链、name 即子类名、身份/上下文/重试提示字段保留、家谱形态可用。
 */

/** 家谱形态：高频错误固化类，身份在类定义处，throw 点只传业务事实（DESIGN §2） */
class InsufficientCashError extends BusinessError {
  constructor(needed: string, available: string) {
    super('Insufficient cash balance', 'billing.insufficient_cash', 'quota_exhausted', {
      needed,
      available,
    });
  }
}

describe('三性根类', () => {
  it('instanceof 链：三类均继承 TokenlensError 与 Error', () => {
    const business = new BusinessError('no', 'app.denied', 'conflict');
    const infra = new InfrastructureError('db down', 'app.db_unavailable');
    const defect = new DefectError('invariant broken', 'app.invariant');

    for (const e of [business, infra, defect]) {
      expect(e).toBeInstanceOf(TokenlensError);
      expect(e).toBeInstanceOf(Error);
    }
    expect(business).not.toBeInstanceOf(InfrastructureError);
    expect(defect).not.toBeInstanceOf(BusinessError);
  });

  it('name 取 new.target——子类名即错误名，不随搬层漂移（E12 回归）', () => {
    expect(new BusinessError('m', 'a.b', 'conflict').name).toBe('BusinessError');
    expect(new InfrastructureError('m', 'a.b').name).toBe('InfrastructureError');
    expect(new DefectError('m', 'a.b').name).toBe('DefectError');
    expect(new InsufficientCashError('5.00', '3.00').name).toBe('InsufficientCashError');
  });

  it('nature 字面量三值互斥', () => {
    expect(new BusinessError('m', 'a.b', 'conflict').nature).toBe('business');
    expect(new InfrastructureError('m', 'a.b').nature).toBe('infrastructure');
    expect(new DefectError('m', 'a.b').nature).toBe('defect');
  });

  it('身份与上下文字段保留；context 接受 JSON 标量四类与 null', () => {
    const context: ErrorContext = { s: 'x', n: 3, b: false, nil: null };
    const e = new BusinessError('denied', 'billing.quota', 'quota_exhausted', context);
    expect(e.code).toBe('billing.quota');
    expect(e.category).toBe('quota_exhausted');
    expect(e.context).toEqual({ s: 'x', n: 3, b: false, nil: null });
    // 引用不复制：调用方传入的上下文对象原样保留（浅层）
    expect(e.context).toBe(context);
  });

  it('opts：cause 原样挂在 Error cause 上，retryAfterMs 保留；缺省均为 undefined', () => {
    const original = new Error('root cause');
    const withOpts = new BusinessError('m', 'a.b', 'rate_limited', undefined, {
      cause: original,
      retryAfterMs: 5000,
    });
    expect(withOpts.cause).toBe(original);
    expect(withOpts.retryAfterMs).toBe(5000);

    const bare = new BusinessError('m', 'a.b', 'conflict');
    expect(bare.cause).toBeUndefined();
    expect(bare.retryAfterMs).toBeUndefined();
  });

  it('家谱形态：固化类携带固定身份与分类，业务事实进 context', () => {
    const e = new InsufficientCashError('5.00', '3.00');
    expect(e).toBeInstanceOf(BusinessError);
    expect(e.code).toBe('billing.insufficient_cash');
    expect(e.category).toBe('quota_exhausted');
    expect(e.message).toBe('Insufficient cash balance');
    expect(e.context).toEqual({ needed: '5.00', available: '3.00' });
  });

  it('基类不可直接实例化（抽象——编译期契约，typecheck 门禁生效）', () => {
    // 抽象仅是编译期约束（JS 运行时可构造），此处锁的是类型面：
    // @ts-expect-error 抽象类不可构造
    void new TokenlensError('m', { code: 'a.b' });
  });
});
