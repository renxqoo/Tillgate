/**
 * 契约级锁定(§10.1):
 * - 状态词汇与 db 物理真相逐项相等(机制位与派生表);
 * - 错误目录封闭词表(namespace、码集合、category 全在七闭集内);
 * - 出口桶快照(公共 API 面)。
 */
import { describe, expect, it } from 'vitest';
import { ACCOUNT_STATUS } from '@tillgate/db';
import { ERROR_CATEGORIES } from '@tillgate/errors';
import * as publicApi from '../src/index.js';
import {
  USER_STATUS,
  CREDENTIAL_STATUS,
  MEMBER_STATUS,
  INVITATION_STATUS,
  REFERRAL_STATUS,
} from '../src/domain/status.js';
import { AccountsErrors } from '../src/domain/errors.js';

describe('状态词汇单一真相(与 db 物理层逐项相等)', () => {
  it('USER_STATUS 与 db ACCOUNT_STATUS 逐项相等', () => {
    expect(USER_STATUS).toEqual(ACCOUNT_STATUS);
  });
  it('词汇常量封闭集合', () => {
    expect(CREDENTIAL_STATUS).toEqual({ ACTIVE: 0, REVOKED: 1 });
    expect(MEMBER_STATUS).toEqual({ ACTIVE: 0, LEFT: 1 });
    expect(INVITATION_STATUS).toEqual({ PENDING: 0, ACCEPTED: 1, REVOKED: 2 });
    expect(REFERRAL_STATUS).toEqual({ ACTIVE: 0, BANNED: 1 });
  });
});

describe('错误目录封闭词表', () => {
  it('namespace = accounts;码全部 accounts.* 前缀', () => {
    expect(AccountsErrors.namespace).toBe('accounts');
    for (const code of AccountsErrors.codes) {
      expect(code.startsWith('accounts.')).toBe(true);
    }
  });
  it('category 全部在七闭集内(目录构造即校验,此处锁行为)', () => {
    for (const code of AccountsErrors.codes) {
      const def = AccountsErrors.get(code);
      expect(def).toBeDefined();
      expect(ERROR_CATEGORIES).toContain(def!.category);
      expect(def!.message.length).toBeGreaterThan(0);
      expect(def!.zh.length).toBeGreaterThan(0);
    }
  });
  it('business() 携带身份码与 context', () => {
    const e = AccountsErrors.business('email_taken', { email: 'a@b.c' });
    expect(e.code).toBe('accounts.email_taken');
    expect(e.category).toBe('conflict');
  });
});

describe('出口桶快照(公共 API 面,加法变更须显式更新本快照)', () => {
  it('导出集合精确锁定', () => {
    expect(Object.keys(publicApi).toSorted()).toEqual([
      'AccountsErrors',
      'CREDENTIAL_STATUS',
      'INVITATION_STATUS',
      'MEMBER_STATUS',
      'REFERRAL_STATUS',
      'USER_STATUS',
      'commissionRefId',
      'createAccounts',
      'decodeAffCode',
      'encodeAffCode',
      'referralSignupRefId',
      'signupGiftRefId',
    ]);
  });
});
