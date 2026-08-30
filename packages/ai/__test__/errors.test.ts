import { describe, expect, it } from 'vitest';
import {
  UpstreamError,
  KIND_MECHANICS,
  isRetryable,
  isDeadCredential,
} from '../src/errors/kinds.js';
import {
  statusKind,
  statusFallbackError,
  tableOrFallback,
  extractVendorCode,
  retryAfterMsOf,
} from '../src/errors/fallback.js';
import {
  emptyError,
  canceledError,
  serverDrainingError,
  unsupportedProtocolError,
  taskOpsUnavailableError,
  invalidConfigError,
} from '../src/errors/internal.js';
import type { ErrorKind } from '../src/errors/kinds.js';

describe('errors/kinds：词表封闭 + 派生表单一真相', () => {
  it('机制位 == 派生表查表值（构造不可覆盖——契约级）', () => {
    for (const kind of Object.keys(KIND_MECHANICS) as ErrorKind[]) {
      const e = new UpstreamError({ kind });
      expect(e.retryable, kind).toBe(KIND_MECHANICS[kind].retryable);
      expect(e.circuitTrip, kind).toBe(KIND_MECHANICS[kind].circuitTrip);
      expect(e.deadCredential, kind).toBe(KIND_MECHANICS[kind].deadCredential);
    }
  });

  it('派生矩阵关键行：限流可重试不熔断；凭据族死标记；5xx/网络族全真', () => {
    expect(KIND_MECHANICS.rate_limited).toEqual({
      retryable: true,
      circuitTrip: false,
      deadCredential: false,
    });
    expect(KIND_MECHANICS.invalid_api_key.deadCredential).toBe(true);
    expect(KIND_MECHANICS.insufficient_permissions.deadCredential).toBe(true);
    expect(KIND_MECHANICS.quota_exhausted.retryable).toBe(false);
    expect(KIND_MECHANICS.network.circuitTrip).toBe(true);
    expect(KIND_MECHANICS.server_draining.circuitTrip).toBe(false);
  });

  it('原始信息保真：vendorCode/status/retryAfterMs/rawBody 随行；Error 兼容', () => {
    const e = new UpstreamError({
      kind: 'rate_limited',
      message: 'slow',
      vendorCode: '429x',
      status: 429,
      retryAfterMs: 1200,
      rawBody: '{...}',
    });
    expect(e).toBeInstanceOf(Error);
    expect(e.vendorCode).toBe('429x');
    expect(e.retryAfterMs).toBe(1200);
    expect(e.rawBody).toBe('{...}');
    expect(isRetryable(e)).toBe(true);
    expect(isDeadCredential(e)).toBe(false);
  });
});

describe('errors/fallback：status 兜底与厂商表（§3.2）', () => {
  it('statusKind 矩阵：529/5xx/429/402/401/403/4xx/undefined', () => {
    expect(statusKind(529)).toBe('overloaded');
    expect(statusKind(502)).toBe('upstream_error');
    expect(statusKind(429)).toBe('rate_limited');
    // 402 欠费归 quota_exhausted（渠道面，可换渠）而非 invalid_request（透传终局）
    expect(statusKind(402)).toBe('quota_exhausted');
    expect(statusKind(401)).toBe('invalid_api_key');
    expect(statusKind(403)).toBe('insufficient_permissions');
    expect(statusKind(400)).toBe('invalid_request');
    expect(statusKind()).toBe('network');
  });

  it('extractVendorCode：OpenAI error.code / anthropic error.type / gemini error.status / 顶层 code', () => {
    expect(extractVendorCode({ error: { code: 'insufficient_quota' } })).toBe('insufficient_quota');
    expect(extractVendorCode({ error: { type: 'overloaded_error' } })).toBe('overloaded_error');
    expect(extractVendorCode({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } })).toBe(
      'RESOURCE_EXHAUSTED',
    );
    expect(extractVendorCode({ code: 'Throttling' })).toBe(`${'Throttning'.slice(0, 0)}Throttling`);
    expect(extractVendorCode('plain')).toBeUndefined();
    expect(extractVendorCode([1])).toBeUndefined();
  });

  it('retryAfterMs：秒数 / HTTP-date / 非法值', () => {
    expect(retryAfterMsOf({ 'retry-after': '2' })).toBe(2000);
    expect(retryAfterMsOf({ 'Retry-After': 'abc' })).toBeUndefined();
    const future = new Date(Date.now() + 5000).toUTCString();
    expect(retryAfterMsOf({ 'retry-after': future })).toBeGreaterThan(3000);
  });

  it('tableOrFallback：表命中 kind；未命中落 status 兜底（B8 结构化消解验证）', () => {
    const table = {
      insufficient_quota: 'quota_exhausted',
      context_length_exceeded: 'context_overflow',
    } as Record<string, ErrorKind>;
    const hit = tableOrFallback({
      table,
      status: 429,
      body: { error: { code: 'insufficient_quota', message: 'x' } },
    });
    expect(hit.kind).toBe('quota_exhausted');
    // max_tokens 输出超限（invalid_request 系）≠ context_overflow——精确 code 才命中
    const out = tableOrFallback({
      table,
      status: 400,
      body: {
        error: { code: 'invalid_value', message: 'too many tokens requested for max_tokens' },
      },
    });
    expect(out.kind).toBe('invalid_request');
    const ctx = tableOrFallback({
      table,
      status: 400,
      body: { error: { code: 'context_length_exceeded' } },
    });
    expect(ctx.kind).toBe('context_overflow');
    const miss = tableOrFallback({ table, status: 500, body: {} });
    expect(miss.kind).toBe('upstream_error');
  });

  it('fallback 构造：429 带 Retry-After 解析；detail/rawBody 保真', () => {
    const e = statusFallbackError(429, { error: { message: 'slow down' } }, 'raw', {
      'retry-after': '1',
    });
    expect(e.kind).toBe('rate_limited');
    expect(e.retryAfterMs).toBe(1000);
    expect(e.message).toBe('slow down');
    expect(e.rawBody).toBe('raw');
  });
});

describe('errors/internal：库策略错误 kind 化', () => {
  it('各构造 kind 正确且机制位派生', () => {
    expect(emptyError().kind).toBe('empty_completion');
    expect(emptyError().retryable).toBe(false);
    expect(canceledError().kind).toBe('canceled');
    expect(serverDrainingError().kind).toBe('server_draining');
    expect(unsupportedProtocolError('x', ['a']).kind).toBe('unsupported_protocol');
    expect(taskOpsUnavailableError('minimax').kind).toBe('task_ops_unavailable');
    expect(invalidConfigError('缺字段').kind).toBe('invalid_config');
  });
});
