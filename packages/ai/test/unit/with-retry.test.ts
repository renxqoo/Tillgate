import { describe, expect, it } from 'vitest';
import { backoffDelayMs, withRetry } from '../../src/retry/with-retry.js';
import type { AttemptOutcome, RetryOptions } from '../../src/retry/with-retry.js';
import { createUpstreamError } from '../../src/errors/classify.js';

const opts: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 1,
  maxDelayMs: 10,
  jitterRatio: 0,
  deadlineMs: 5000,
  emptyCompletionRetries: 2,
};

function err(code: string, retryable: boolean) {
  return createUpstreamError({ code, message: code, retryable, circuitTrip: retryable });
}

describe('withRetry', () => {
  it('可重试错误重试至成功', async () => {
    let calls = 0;
    const fn = async (): Promise<AttemptOutcome<string>> => {
      calls += 1;
      return calls < 3
        ? { ok: false, error: err('upstream_error', true) }
        : { ok: true, value: 'done' };
    };
    const { outcome, attempts } = await withRetry(fn, opts);
    expect(outcome.ok).toBe(true);
    expect(attempts).toBe(3);
  });

  it('不可重试错误不重试', async () => {
    let calls = 0;
    const fn = async (): Promise<AttemptOutcome<string>> => {
      calls += 1;
      return { ok: false, error: err('invalid_request', false) };
    };
    const { outcome, attempts } = await withRetry(fn, opts);
    expect(outcome.ok).toBe(false);
    expect(attempts).toBe(1);
    expect(calls).toBe(1);
  });

  it('429（retryable, 不计熔断）照常重试', async () => {
    let calls = 0;
    const fn = async (): Promise<AttemptOutcome<string>> => {
      calls += 1;
      return calls < 2
        ? { ok: false, error: err('rate_limited', true) }
        : { ok: true, value: 'ok' };
    };
    const { outcome, attempts } = await withRetry(fn, opts);
    expect(outcome.ok).toBe(true);
    expect(attempts).toBe(2);
  });

  it('空完成重试 ≤ emptyCompletionRetries（2 次）', async () => {
    let calls = 0;
    const fn = async (): Promise<AttemptOutcome<string>> => {
      calls += 1;
      return calls < 4
        ? { ok: false, error: err('empty', false), empty: true }
        : { ok: true, value: 'ok' };
    };
    const { outcome, attempts } = await withRetry(fn, opts);
    expect(attempts).toBe(3); // 空完成重试 2 次后停止（calls=3 时 emptyCount=2 不再重试）
    expect(outcome.ok).toBe(false);
  });

  it('总 deadline 中止重试', async () => {
    const slowOpts: RetryOptions = { ...opts, baseDelayMs: 1000, maxDelayMs: 1000, deadlineMs: 50 };
    let calls = 0;
    const started = Date.now();
    const fn = async (_attempt: number, signal: AbortSignal): Promise<AttemptOutcome<string>> => {
      calls += 1;
      void signal;
      return { ok: false, error: err('upstream_error', true) };
    };
    const { attempts } = await withRetry(fn, slowOpts);
    expect(Date.now() - started).toBeLessThan(300);
    expect(attempts).toBe(1); // 首次失败后等待退避，deadline 到 → 不再重试
    expect(calls).toBe(1);
  });

  it('onRetry 回调收到退避信息', async () => {
    let calls = 0;
    const infos: number[] = [];
    const fn = async (): Promise<AttemptOutcome<string>> => {
      calls += 1;
      return calls < 2
        ? { ok: false, error: err('upstream_error', true) }
        : { ok: true, value: 'ok' };
    };
    await withRetry(fn, opts, (info) => infos.push(info.attempt));
    expect(infos).toEqual([1]);
  });
});

describe('backoffDelayMs', () => {
  it('无抖动时 = min(base × 2^n, max)', () => {
    expect(backoffDelayMs(0, 100, 1000, 0)).toBe(100);
    expect(backoffDelayMs(1, 100, 1000, 0)).toBe(200);
    expect(backoffDelayMs(2, 100, 1000, 0)).toBe(400);
    expect(backoffDelayMs(5, 100, 1000, 0)).toBe(1000); // 封顶
  });

  it('抖动在 [exp, exp×(1+jitter)] 范围内', () => {
    for (let i = 0; i < 50; i++) {
      const d = backoffDelayMs(1, 100, 10000, 0.25);
      expect(d).toBeGreaterThanOrEqual(200);
      expect(d).toBeLessThanOrEqual(250);
    }
  });
});
