import { describe, expect, it } from 'vitest';

import { defineErrorCatalog } from '../src/definition';
import {
  BusinessError,
  DefectError,
  InfrastructureError,
  TillgateError,
  type ErrorContext,
} from '../src/nature';

/**
 * 三性根类契约：instanceof 链、name 即子类名、身份/上下文/重试提示字段保留、家谱形态可用。
 * 业务码经目录签发：品牌 + 绑定构造，自由字符串编译期封闭。
 */

const TestErrors = defineErrorCatalog('naturetest', {
  denied: { category: 'conflict', message: 'no', zh: '否' },
  quota: { category: 'quota_exhausted', message: 'Insufficient cash balance', zh: '现金余额不足' },
  throttled: { category: 'rate_limited', message: 'slow down', zh: '慢一点' },
});

/** 家谱形态：高频错误固化类；entry() 绑定定义——类与目录零漂移 */
class InsufficientCashError extends BusinessError {
  constructor(needed: string, available: string) {
    super(TestErrors.entry('quota'), { needed, available });
  }
}

describe('三性根类', () => {
  it('instanceof 链：三类均继承 TillgateError 与 Error', () => {
    const business = TestErrors.business('denied');
    const infra = new InfrastructureError('db down', 'app.db_unavailable');
    const defect = new DefectError('invariant broken', 'app.invariant');

    for (const e of [business, infra, defect]) {
      expect(e).toBeInstanceOf(TillgateError);
      expect(e).toBeInstanceOf(Error);
    }
    expect(business).not.toBeInstanceOf(InfrastructureError);
    expect(defect).not.toBeInstanceOf(BusinessError);
  });

  it('name 取 new.target——子类名即错误名，不随搬层漂移（E12 回归）', () => {
    expect(new BusinessError(TestErrors.entry('denied')).name).toBe('BusinessError');
    expect(new InfrastructureError('m', 'a.b').name).toBe('InfrastructureError');
    expect(new DefectError('m', 'a.b').name).toBe('DefectError');
    expect(new InsufficientCashError('5.00', '3.00').name).toBe('InsufficientCashError');
  });

  it('nature 字面量三值互斥', () => {
    expect(TestErrors.business('denied').nature).toBe('business');
    expect(new InfrastructureError('m', 'a.b').nature).toBe('infrastructure');
    expect(new DefectError('m', 'a.b').nature).toBe('defect');
  });

  it('身份与上下文字段保留；context 接受 JSON 标量四类与 null', () => {
    const context: ErrorContext = { s: 'x', n: 3, b: false, nil: null };
    const e = new BusinessError(TestErrors.entry('quota'), context);
    expect(e.code).toBe('naturetest.quota');
    expect(e.category).toBe('quota_exhausted');
    expect(e.context).toEqual({ s: 'x', n: 3, b: false, nil: null });
    // 引用不复制：调用方传入的上下文对象原样保留（浅层）
    expect(e.context).toBe(context);
  });

  it('context 收递归只读 JSON 值：数组与嵌套对象透传（D9a）', () => {
    const e = new BusinessError(TestErrors.entry('quota'), {
      fields: [{ path: 'amount', reason: 'not a decimal' }],
      nested: { a: 1, list: ['x', null, true] },
    });
    expect(e.context).toEqual({
      fields: [{ path: 'amount', reason: 'not a decimal' }],
      nested: { a: 1, list: ['x', null, true] },
    });
  });

  it('opts：cause 原样挂在 Error cause 上，retryAfterMs 保留；缺省均为 undefined', () => {
    const original = new Error('root cause');
    const withOpts = new BusinessError(TestErrors.entry('throttled'), undefined, {
      cause: original,
      retryAfterMs: 5000,
    });
    expect(withOpts.cause).toBe(original);
    expect(withOpts.retryAfterMs).toBe(5000);

    const bare = TestErrors.business('denied');
    expect(bare.cause).toBeUndefined();
    expect(bare.retryAfterMs).toBeUndefined();
  });

  it('家谱形态：entry() 绑定构造——文案/分类/身份全部来自目录定义（D8 零漂移）', () => {
    const e = new InsufficientCashError('5.00', '3.00');
    expect(e).toBeInstanceOf(BusinessError);
    expect(e.code).toBe('naturetest.quota');
    expect(e.category).toBe('quota_exhausted');
    expect(e.message).toBe('Insufficient cash balance'); // 目录文案，子类不可偏离
    expect(e.context).toEqual({ needed: '5.00', available: '3.00' });
  });

  it('编译锁：自由字符串不可作为业务身份码（E2 编译期封闭，typecheck 门禁生效）', () => {
    // 品牌/抽象仅是编译期约束（JS 运行时可构造），此处锁的是类型面。
    // 指令紧贴报错属性行（oxfmt 保持字面量多行，指令不漂移）：
    void new BusinessError({
      // @ts-expect-error 自由字符串无品牌，不可作为业务身份码——必须由目录签发
      code: 'naturetest.quota',
      category: 'quota_exhausted',
      message: '盗用文案',
    });
  });

  it('基类不可直接实例化（抽象——编译期契约，typecheck 门禁生效）', () => {
    // @ts-expect-error 抽象类不可构造
    void new TillgateError('m', { code: 'a.b' });
  });
});
