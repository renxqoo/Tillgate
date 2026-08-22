import { describe, expect, it } from 'vitest';

import { composeErrorCatalogs, defineErrorCatalog, type ErrorDefinition } from '../src/definition';
import { isBusinessError, isDefectError } from '../src/guards';
import { DefectError } from '../src/nature';
import { ROOT_ERROR_CODES } from '../src/error-record';

/**
 * 错误目录契约（ADR-0001 D1-D3）：能力包自有定义 + face 装配。
 * 回归映射：E2（自由码）/E3（表漂移）/E6（跨包冲突）/E7（大小写双轨）/
 * E8（文案不可本地化）/E9（message 即 code）/E13（隐式默认）。
 */

const BillingErrors = defineErrorCatalog('billing', {
  insufficient_cash: {
    category: 'quota_exhausted',
    message: 'Insufficient cash balance',
    zh: '现金余额不足',
  },
  plan_disabled: { category: 'conflict', message: 'Plan is disabled', zh: '套餐已停售' },
});

const IdentityErrors = defineErrorCatalog('identity', {
  session_invalid: {
    category: 'forbidden',
    message: 'Session invalid or expired',
    zh: '会话无效或已过期',
  },
});

/** 断言 fn 抛 DefectError 并返回其身份码 */
function defectCodeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (isDefectError(e)) return e.code;
    throw new Error('expected DefectError', { cause: e });
  }
  throw new Error('expected DefectError, nothing thrown');
}

describe('defineErrorCatalog', () => {
  it('code()：命名空间前缀拼接（编译期模板字面量类型）', () => {
    expect(BillingErrors.code('insufficient_cash')).toBe('billing.insufficient_cash');
    expect(BillingErrors.namespace).toBe('billing');
  });

  it('get/has：完整身份码命中；前缀不符/未登记/多段伪造码均 miss', () => {
    expect(BillingErrors.get('billing.insufficient_cash')?.category).toBe('quota_exhausted');
    expect(BillingErrors.has('billing.insufficient_cash')).toBe(true);
    expect(BillingErrors.get('identity.session_invalid')).toBeUndefined();
    expect(BillingErrors.get('billing.nope')).toBeUndefined();
    expect(BillingErrors.get('billing.a.b')).toBeUndefined(); // 多段伪造 key 必然 miss
    expect(BillingErrors.has('billing.nope')).toBe(false);
    expect(BillingErrors.get('nope')).toBeUndefined();
  });

  it('codes：全部身份码带命名空间前缀', () => {
    expect([...BillingErrors.codes]).toEqual([
      'billing.insufficient_cash',
      'billing.plan_disabled',
    ]);
  });

  it('business()：文案/身份/分类单点来自定义，不由调用点提供（E8/E9 回归）', () => {
    const e = BillingErrors.business('insufficient_cash', { needed: '5.00', available: '3.00' });
    expect(isBusinessError(e)).toBe(true);
    expect(e.code).toBe('billing.insufficient_cash');
    expect(e.category).toBe('quota_exhausted');
    expect(e.message).toBe('Insufficient cash balance'); // 定义文案，非调用点拼接
    expect(e.context).toEqual({ needed: '5.00', available: '3.00' });
  });

  it('business()：opts 透传 cause 与 retryAfterMs', () => {
    const root = new Error('db');
    const e = BillingErrors.business('plan_disabled', undefined, {
      cause: root,
      retryAfterMs: 1000,
    });
    expect(e.cause).toBe(root);
    expect(e.retryAfterMs).toBe(1000);
  });

  it('business()：未登记 key → 缺陷 errors.catalog_key_missing（编译期之外的运行时防呆）', () => {
    // @ts-expect-error 类型面不存在该 key；此处验证 JS 调用方的运行时防呆
    const fn = () => BillingErrors.business('nope');
    expect(defectCodeOf(fn)).toBe(ROOT_ERROR_CODES.catalogKeyMissing);
  });

  it('装配期形状防呆：坏命名空间/坏 key/坏 category/空文案均 fail-fast（E13 回归）', () => {
    const def = { category: 'conflict', message: 'm', zh: '中' } satisfies ErrorDefinition;
    expect(defectCodeOf(() => defineErrorCatalog('Billing', { x: def }))).toBe(
      ROOT_ERROR_CODES.catalogKeyInvalid,
    );
    expect(defectCodeOf(() => defineErrorCatalog('t', { 'Bad-Key': def }))).toBe(
      ROOT_ERROR_CODES.catalogKeyInvalid,
    );
    expect(
      defectCodeOf(() => defineErrorCatalog('t', { x: { ...def, category: 'nope' as never } })),
    ).toBe(ROOT_ERROR_CODES.catalogKeyInvalid);
    expect(defectCodeOf(() => defineErrorCatalog('t', { x: { ...def, message: '' } }))).toBe(
      ROOT_ERROR_CODES.catalogKeyInvalid,
    );
    expect(defectCodeOf(() => defineErrorCatalog('t', { x: { ...def, zh: '' } }))).toBe(
      ROOT_ERROR_CODES.catalogKeyInvalid,
    );
  });

  it('business()：形状非法的 key（多段/大写）同样 fail-fast，不进入查找', () => {
    // @ts-expect-error 运行时防呆验证：key 形状非法
    expect(defectCodeOf(() => BillingErrors.business('Bad-Key'))).toBe(
      ROOT_ERROR_CODES.catalogKeyInvalid,
    );
  });

  it('定义非对象（JS 调用方绕过类型）装配期 fail-fast', () => {
    expect(defectCodeOf(() => defineErrorCatalog('t', { x: null as never }))).toBe(
      ROOT_ERROR_CODES.catalogKeyInvalid,
    );
  });

  it('定义入目录后与源对象隔离，目录与条目均冻结', () => {
    const source: { plan_disabled: { category: 'conflict'; message: string; zh: string } } = {
      plan_disabled: { category: 'conflict', message: 'Plan is disabled', zh: '套餐已停售' },
    };
    const catalog = defineErrorCatalog('isolated', source);
    source.plan_disabled.message = 'MUTATED';
    expect(catalog.get('isolated.plan_disabled')?.message).toBe('Plan is disabled'); // 拷贝隔离

    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.codes)).toBe(true);
    expect(Object.isFrozen(catalog.get('isolated.plan_disabled'))).toBe(true);
  });
});

describe('composeErrorCatalogs（face 装配）', () => {
  const composed = composeErrorCatalogs(BillingErrors, IdentityErrors);

  it('跨目录查询与聚合 codes', () => {
    expect(composed.get('billing.insufficient_cash')?.zh).toBe('现金余额不足');
    expect(composed.get('identity.session_invalid')?.category).toBe('forbidden');
    expect(composed.has('billing.plan_disabled')).toBe(true);
    expect(composed.has('billing.nope')).toBe(false);
    expect([...composed.codes]).toContain('identity.session_invalid');
  });

  it('命名空间重复 → 装配期缺陷 errors.duplicate_namespace（E6 回归）', () => {
    expect(defectCodeOf(() => composeErrorCatalogs(BillingErrors, BillingErrors))).toBe(
      ROOT_ERROR_CODES.duplicateNamespace,
    );
  });

  it('不同命名空间的同名 key 互不冲突（v1 跨包同码冲突的结构修复）', () => {
    const a = defineErrorCatalog('alpha', {
      shared: { category: 'conflict', message: 'A', zh: '甲' },
    });
    const b = defineErrorCatalog('beta', {
      shared: { category: 'not_found', message: 'B', zh: '乙' },
    });
    const merged = composeErrorCatalogs(a, b);
    expect(merged.get('alpha.shared')?.message).toBe('A');
    expect(merged.get('beta.shared')?.message).toBe('B');
  });

  it('合成目录自身冻结', () => {
    expect(Object.isFrozen(composed)).toBe(true);
    expect(Object.isFrozen(composed.codes)).toBe(true);
  });

  it('防呆抛出的是 DefectError 实例（可被守卫精确捕获）', () => {
    try {
      composeErrorCatalogs(BillingErrors, BillingErrors);
    } catch (e) {
      expect(e).toBeInstanceOf(DefectError);
      return;
    }
    throw new Error('expected throw');
  });
});
