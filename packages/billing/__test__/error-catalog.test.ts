/**
 * 错误目录词表封闭性（§10.1 契约级：导出枚举 == 文档词表；目录是码的唯一登记处）。
 * 新增条目必须同步本快照与 DESIGN/IMPLEMENTATION 记录——契约变了测试必须同步变。
 */
import { describe, expect, it } from 'vitest';
import { isErrorCategory } from '@tillgate/errors';
import { BillingErrors } from '../src/domain/errors.js';
import { defined } from './defined.js';

/** 词表快照：key → category（封闭；增删走本文件 + 文档同步） */
const EXPECTED: Record<string, string> = {
  invalid_period_days: 'invalid_input',
  invalid_review_command: 'invalid_input',
  plan_in_use: 'conflict',
  redeem_batch_not_found: 'not_found',
  redeem_code_not_found: 'not_found',
  invalid_amount: 'invalid_input',
  invalid_ref: 'invalid_input',
  insufficient_balance: 'quota_exhausted',
  insufficient_cash: 'quota_exhausted',
  credit_limit_conflict: 'conflict',
  authorization_not_active: 'conflict',
  settle_exceeds_hold: 'invalid_input',
  account_frozen: 'forbidden',
  ref_key_conflict: 'conflict',
  idempotency_conflict: 'conflict',
  authorization_not_found: 'not_found',
  invalid_quote: 'invalid_input',
  invalid_coefficient: 'invalid_input',
  invalid_reservation_estimate: 'invalid_input',
  invalid_reservation_limit: 'invalid_input',
  reservation_limit_exceeded: 'quota_exhausted',
  invalid_reservation_balance: 'invalid_input',
  invalid_reservation_units: 'invalid_input',
  unknown_reservation_strategy: 'invalid_input',
  poison_receipt: 'invalid_input',
  receipt_user_mismatch: 'invalid_input',
  state_conflict: 'conflict',
  daily_spend_limit: 'quota_exhausted',
  member_daily_limit: 'quota_exhausted',
  member_monthly_quota: 'quota_exhausted',
  subscription_forbidden: 'forbidden',
  subscription_required: 'quota_exhausted',
  subscription_quota_exhausted: 'quota_exhausted',
  settlement_backlog: 'unavailable',
  plan_not_found: 'not_found',
  plan_disabled: 'conflict',
  plan_not_purchasable: 'invalid_input',
  not_a_pack: 'invalid_input',
  user_not_found: 'not_found',
  subscription_state: 'conflict',
  subscription_rule: 'invalid_input',
  topup_amount_invalid: 'invalid_input',
  payment_unavailable: 'unavailable',
  payment_channel_unavailable: 'unavailable',
  topup_rate_limited: 'rate_limited',
  order_not_found: 'not_found',
  order_state_conflict: 'conflict',
  rate_counter_unavailable: 'unavailable',
  invalid_code: 'not_found',
  code_revoked: 'conflict',
  code_already_used: 'conflict',
  code_expired: 'invalid_input',
  redeem_rate_limited: 'rate_limited',
};

describe('billing 错误目录', () => {
  it('codes 与词表快照逐项相等（封闭性）', () => {
    expect([...BillingErrors.codes].toSorted()).toEqual(
      Object.keys(EXPECTED)
        .map((key) => `billing.${key}`)
        .toSorted(),
    );
  });

  it('每条 category 合法且 message/zh 非空（结构性消灭登记缺中文/空文案）', () => {
    for (const code of BillingErrors.codes) {
      const def = BillingErrors.get(code);
      expect(def, code).toBeDefined();
      expect(isErrorCategory(defined(def).category), code).toBe(true);
      expect(defined(def).category, code).toBe(EXPECTED[code.slice('billing.'.length)]);
      expect(defined(def).message.length, code).toBeGreaterThan(0);
      expect(defined(def).zh.length, code).toBeGreaterThan(0);
    }
  });

  it('code()/business() 签发与查询闭环；未登记码查询 miss', () => {
    expect(BillingErrors.code('insufficient_cash')).toBe('billing.insufficient_cash');
    expect(BillingErrors.has('billing.insufficient_cash')).toBe(true);
    expect(BillingErrors.has('billing.nope')).toBe(false);
    expect(BillingErrors.get('billing.nope')).toBeUndefined();
  });

  it('business() 构造完整身份（nature=business + category + context 透传）', () => {
    const error = BillingErrors.business('invalid_amount', { raw: 'x', reason: 'malformed' });
    expect(error.nature).toBe('business');
    expect(error.code).toBe('billing.invalid_amount');
    expect(error.category).toBe('invalid_input');
    expect(error.context).toEqual({ raw: 'x', reason: 'malformed' });
  });
});
