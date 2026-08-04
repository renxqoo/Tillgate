import { describe, expect, it } from 'vitest';
import {
  classifyHttpError,
  classifyTransportError,
  DEFAULT_DEAD_CREDENTIAL_PATTERNS,
} from '../../src/errors/classify.js';

describe('classifyHttpError', () => {
  it.each([
    // [status, body, expected code, retryable, circuitTrip, deadCredential]
    [500, { error: { message: 'boom' } }, 'upstream_error', true, true, false],
    [502, { message: 'bad gateway' }, 'upstream_error', true, true, false],
    [503, {}, 'upstream_error', true, true, false],
    [429, { error: { message: 'rate limited' } }, 'rate_limited', true, false, false],
    [
      401,
      { error: { message: 'Incorrect API key provided' } },
      'invalid_api_key',
      false,
      false,
      true,
    ],
    [401, { error: { message: '认证失败' } }, 'invalid_api_key', false, false, true],
    [403, { error: { message: 'unauthorized' } }, 'forbidden', false, false, true],
    [403, { error: { message: 'model access forbidden' } }, 'forbidden', false, false, false],
    [400, { error: { message: 'bad request' } }, 'invalid_request', false, false, false],
    [404, { error: { message: 'model not found' } }, 'model_not_found', false, false, false],
    [418, { message: 'teapot' }, 'upstream_error', false, false, false],
  ])(
    'status %i → code=%s retryable=%s circuitTrip=%s deadCredential=%s',
    (status, body, code, retryable, circuitTrip, deadCredential) => {
      const err = classifyHttpError(status as number, body);
      expect(err.status).toBe(status);
      expect(err.code).toBe(code);
      expect(err.retryable).toBe(retryable);
      expect(err.circuitTrip).toBe(circuitTrip);
      expect(err.deadCredential).toBe(deadCredential);
    },
  );

  it('body 中的 code 优先于默认分类', () => {
    const err = classifyHttpError(500, { error: { code: 'insufficient_quota', message: 'quota' } });
    expect(err.code).toBe('insufficient_quota');
    expect(err.retryable).toBe(true);
  });

  it('5xx 带 suggestion', () => {
    expect(classifyHttpError(500, {}).suggestion).toBeTruthy();
  });

  it('自定义死凭据特征生效', () => {
    const err = classifyHttpError(
      403,
      { error: { message: 'custom-secret-issue' } },
      {
        deadCredentialPatterns: [/custom-secret/i],
      },
    );
    expect(err.deadCredential).toBe(true);
  });

  it('默认特征表包含关键模式', () => {
    expect(DEFAULT_DEAD_CREDENTIAL_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe('classifyTransportError', () => {
  it('timeout → retryable + circuitTrip', () => {
    const err = classifyTransportError('timeout');
    expect(err.code).toBe('timeout');
    expect(err.retryable).toBe(true);
    expect(err.circuitTrip).toBe(true);
    expect(err.status).toBeUndefined();
  });

  it('network → retryable + circuitTrip', () => {
    const err = classifyTransportError('network');
    expect(err.code).toBe('network');
    expect(err.retryable).toBe(true);
    expect(err.circuitTrip).toBe(true);
  });
});
