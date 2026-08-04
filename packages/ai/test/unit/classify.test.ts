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
    [408, { error: { message: 'request timeout' } }, 'timeout', true, true, false],
    [413, { error: { message: 'too large' } }, 'payload_too_large', false, false, false],
    [418, { message: 'teapot' }, 'http_error', false, false, false],
    [302, { message: 'redirect' }, 'http_error', false, false, false],
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

  it('429 限流（RPM/TPM）：retryable=true', () => {
    const err = classifyHttpError(429, { error: { code: 'rate_limit_error', message: 'too many requests' } });
    expect(err.code).toBe('rate_limit_error');
    expect(err.retryable).toBe(true);
  });

  it('429 MiniMax 窗口配额（Token Plan 5h，可恢复）：retryable=true（限流而非额度耗尽）', () => {
    // MiniMax 真实返回：code=rate_limit_error + "用量上限/套餐/积分"，但 5h 窗口后自动恢复 → 限流
    const err = classifyHttpError(429, {
      error: { code: 'rate_limit_error', message: '已达到 Token Plan 用量上限：请升级套餐或购买积分 (2056)' },
    });
    expect(err.code).toBe('rate_limit_error'); // 保持供应商 code
    expect(err.retryable).toBe(true); // 可恢复，应重试
  });

  it('429 账户余额耗尽（body code insufficient_quota）：retryable=false', () => {
    // OpenAI 真实 code：明确是计费耗尽，需充值才恢复
    const err = classifyHttpError(429, { error: { code: 'insufficient_quota', message: 'over limit' } });
    expect(err.code).toBe('quota_exhausted');
    expect(err.retryable).toBe(false);
    expect(err.circuitTrip).toBe(false);
  });

  it('429 账户余额耗尽（message「余额不足/请充值」）：retryable=false', () => {
    const err = classifyHttpError(429, { error: { message: '账户余额不足，请充值后使用' } });
    expect(err.code).toBe('quota_exhausted');
    expect(err.retryable).toBe(false);
  });

  it('429 英文余额耗尽（insufficient balance / billing）：retryable=false', () => {
    const err = classifyHttpError(429, { error: { message: 'insufficient balance, please top up' } });
    expect(err.code).toBe('quota_exhausted');
    expect(err.retryable).toBe(false);
  });

  it('429 边界：「exceeded your current quota」无明确余额词 → 限流（保守，避免误判窗口限制）', () => {
    // 仅 exceeded + quota，无 balance/billing/insufficient → 不判额度耗尽（可能是窗口限制）
    const err = classifyHttpError(429, { error: { message: 'You exceeded your current quota' } });
    expect(err.retryable).toBe(true); // 保守判为限流
  });

  it('自定义额度特征生效', () => {
    const err = classifyHttpError(
      429,
      { error: { message: 'custom-billing-issue' } },
      { quotaExhaustedPatterns: [/custom-billing/i] },
    );
    expect(err.code).toBe('quota_exhausted');
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
