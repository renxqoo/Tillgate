/**
 * 错误目录测试:码表封闭快照、category 分布、
 * business() 抛出形状。
 */
import { describe, expect, it } from 'vitest';
import { identityErrors } from '../src/domain/errors.js';
import { defined } from './defined.js';

/** 错误目录表的测试侧快照 */
const EXPECTED: Readonly<Record<string, string>> = {
  invalid_input: 'invalid_input',
  unknown_identifier_kind: 'invalid_input',
  unknown_provider: 'invalid_input',
  unknown_challenge_kind: 'invalid_input',
  unknown_realm: 'invalid_input',
  invalid_identifier: 'invalid_input',
  invalid_user_id: 'invalid_input',
  invalid_subject: 'invalid_input',
  weak_password: 'invalid_input',
  invalid_credentials: 'forbidden',
  identifier_taken: 'conflict',
  challenge_invalid: 'invalid_input',
  code_invalid: 'invalid_input',
  challenge_cooldown: 'rate_limited',
  undeliverable_challenge: 'unavailable',
  delivery_failed: 'unavailable',
  oauth_link_not_found: 'not_found',
  provider_already_linked: 'conflict',
  last_credential: 'forbidden',
  totp_not_enrolled: 'forbidden',
  totp_already_enrolled: 'conflict',
  invalid_totp_code: 'forbidden',
  invalid_token: 'forbidden',
  captcha_invalid: 'invalid_input',
  captcha_unavailable: 'unavailable',
  oauth_state_invalid: 'invalid_input',
  oauth_state_unavailable: 'unavailable',
  oauth_provider_unconfigured: 'not_found',
  oauth_profile_failed: 'unavailable',
};

describe('identity 错误目录', () => {
  it('码表封闭快照 + category 分布与 DESIGN §2.3 逐项相等', () => {
    const allCodes = [...identityErrors.codes];
    expect(allCodes.toSorted()).toEqual(
      Object.keys(EXPECTED)
        .map((k) => `identity.${k}`)
        .toSorted(),
    );
    for (const [code, category] of Object.entries(EXPECTED)) {
      const entry = identityErrors.get(identityErrors.code(code as never));
      expect(entry, code).toBeDefined();
      // 上行 toBeDefined 失败即中止,defined 仅做类型收窄不影响断言语义
      const resolved = defined(entry, `entry(${code})`);
      expect(resolved.category, code).toBe(category);
      expect(resolved.message.length, code).toBeGreaterThan(0);
      expect(resolved.zh.length, code).toBeGreaterThan(0);
      expect(resolved.message, code).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  it('全码带命名空间前缀且唯一', () => {
    const codes = [...identityErrors.codes];
    expect(codes.every((code) => code.startsWith('identity.'))).toBe(true);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('business() 构造:码/category/文案来自目录,context 携带动态事实(调用方 throw)', () => {
    const error = identityErrors.business('code_invalid', { remainingAttempts: 3 });
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('identity.code_invalid');
    expect(error.category).toBe('invalid_input');
    expect(error.message).toBe('Verification code is incorrect');
    expect(error.context).toEqual({ remainingAttempts: 3 });
  });
});
