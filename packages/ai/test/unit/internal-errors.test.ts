import { describe, expect, it } from 'vitest';
import {
  abortedError,
  circuitOpenError,
  emptyError,
  invalidResponseError,
} from '../../src/errors/internal.js';

/** 包内策略性错误：统一不重试、不跳闸，各带专属机制驱动 */
describe('errors/internal（包内策略性错误）', () => {
  it('emptyError：不重试（空完成由 empty 标志驱动）、不计熔断', () => {
    const err = emptyError();
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('empty_completion');
    expect(err.retryable).toBe(false);
    expect(err.circuitTrip).toBe(false);
    expect(err.status).toBeUndefined();
  });

  it('invalidResponseError：不重试、不计熔断', () => {
    const err = invalidResponseError();
    expect(err.code).toBe('invalid_response');
    expect(err.retryable).toBe(false);
    expect(err.circuitTrip).toBe(false);
  });

  it('abortedError：不重试、不计熔断（deadline 由 withRetry signal 驱动）', () => {
    const err = abortedError();
    expect(err.code).toBe('aborted');
    expect(err.retryable).toBe(false);
    expect(err.circuitTrip).toBe(false);
  });

  it('circuitOpenError：不重试、不计熔断，带用户建议', () => {
    const err = circuitOpenError();
    expect(err.code).toBe('circuit_open');
    expect(err.retryable).toBe(false);
    expect(err.circuitTrip).toBe(false);
    expect(err.suggestion).toContain('熔断');
  });

  it('每次调用返回独立 Error 实例（堆栈各自）', () => {
    expect(emptyError()).not.toBe(emptyError());
  });
});
