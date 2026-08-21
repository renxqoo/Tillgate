/** 白名单与形状守卫：kinds fail-closed / operationId 词表 / createLedger fail fast */
import { describe, expect, it } from 'vitest';
import { createLedger } from '../ledger';
import { assertOperationId, guardKind, buildGuards, OPERATION_ID_RE } from '../validation';
import {
  InvalidInputError,
  InvalidOperationIdError,
  UnknownOperationKindError,
} from '../errors';
import { db } from './helpers';

const guards = buildGuards(['payment.credit', 'order.place']);

describe('guardKind', () => {
  it('白名单外 → UnknownOperationKindError（带 allowed）；形状非法 → InvalidInputError', () => {
    expect(() => guardKind('gift.grant', guards)).toThrow(UnknownOperationKindError);
    try {
      guardKind('gift.grant', guards);
    } catch (e) {
      expect((e as UnknownOperationKindError).allowed).toEqual(['payment.credit', 'order.place']);
    }
    expect(() => guardKind('Bad Kind', guards)).toThrow(InvalidInputError);
    expect(() => guardKind('x', guards)).toThrow(InvalidInputError); // 最短 2 位
  });
});

describe('assertOperationId', () => {
  it('合法：字母数字开头，可含 . _ : -，≤128 位', () => {
    for (const ok of ['a', 'payment.credit:epay:20260816-001', 'order.place.42', 'x-y_z:w']) {
      expect(assertOperationId(ok)).toBe(ok);
    }
  });

  it('非法：空/超长/首字符非字母数字/空格/引号/分号/emoji', () => {
    const bad = ['', ' leading', 'sp ace', `'; drop table--`, 'a'.repeat(129), '.dot', ':colon', '好'];
    for (const value of bad) {
      expect(() => assertOperationId(value)).toThrow(InvalidOperationIdError);
    }
    expect(() => assertOperationId(42 as never)).toThrow(InvalidOperationIdError);
    expect(OPERATION_ID_RE.test('a'.repeat(128))).toBe(true);
  });
});

describe('createLedger 配置 fail fast', () => {
  it('kinds 必填数组、形状合法、无重复', () => {
    expect(() => createLedger(db, { kinds: [] })).toThrow(InvalidInputError);
    expect(() => createLedger(db, {} as never)).toThrow(InvalidInputError);
    expect(() => createLedger(db, { kinds: ['ok.kind', 'Bad'] })).toThrow(InvalidInputError);
    expect(() => createLedger(db, { kinds: ['a.b', 'a.b'] })).toThrow(InvalidInputError);
    expect(() => createLedger(db, { kinds: ['ok.kind'] })).not.toThrow();
  });
});
