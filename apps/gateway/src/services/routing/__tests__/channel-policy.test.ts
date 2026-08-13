import { describe, expect, it } from 'vitest';
import { isDeadCredentialError } from '../channel-policy.js';

describe('isDeadCredentialError', () => {
  it('invalid_api_key → true', () => {
    expect(isDeadCredentialError('invalid_api_key')).toBe(true);
  });

  it('undefined → false', () => {
    expect(isDeadCredentialError(undefined)).toBe(false);
  });

  it('其他错误码 → false', () => {
    expect(isDeadCredentialError('upstream_error')).toBe(false);
    expect(isDeadCredentialError('rate_limited')).toBe(false);
    expect(isDeadCredentialError('timeout')).toBe(false);
    expect(isDeadCredentialError('circuit_open')).toBe(false);
    expect(isDeadCredentialError('network')).toBe(false);
  });

  it('空字符串 → false', () => {
    expect(isDeadCredentialError('')).toBe(false);
  });
});
