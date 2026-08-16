import { describe, expect, it } from 'vitest';
import { isDeadCredentialError } from '../channel-policy.js';

describe('isDeadCredentialError', () => {
  it('deadCredential 标志（classify 单一真相：401 恒真 / 403 命中特征）→ true', () => {
    expect(isDeadCredentialError({ deadCredential: true })).toBe(true);
    expect(isDeadCredentialError({ code: 'invalid_api_key', deadCredential: true })).toBe(true);
    // 403 命中文本特征：classify 归一 code=forbidden 但标志为真——词表统一前漏判
    expect(isDeadCredentialError({ code: 'forbidden', deadCredential: true })).toBe(true);
  });

  it('undefined / 无标志 → false', () => {
    expect(isDeadCredentialError(undefined)).toBe(false);
    expect(isDeadCredentialError({ code: 'invalid_api_key', deadCredential: false })).toBe(false);
    expect(isDeadCredentialError({ code: 'upstream_error' })).toBe(false);
    expect(isDeadCredentialError({ code: 'rate_limited', deadCredential: false })).toBe(false);
  });
});
