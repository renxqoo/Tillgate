/**
 * identity 装配配置解析测试:OAuth 上游策略块(oauthUpstream)的界内校验、
 * 缺省透传(不提供 → resolved 无该块,由装配面补缺省)与越界拒绝。
 */
import { describe, expect, it } from 'vitest';
import { resolveConfig, OAUTH_UPSTREAM_DEFAULTS } from '../src/domain/config.js';
import { TEST_CONFIG } from '../src/testing/harness.js';

// 模块级:业务错误 message 固定,字段事实在 context——按包内惯例断言码 + field
function fieldOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    const err = error as { code?: string; context?: { field?: string } };
    return `${err.code}:${err.context?.field}`;
  }
  return 'no-throw';
}

describe('resolveConfig oauthUpstream', () => {
  it('缺省:不提供 → resolved 不带该块(装配面补 OAUTH_UPSTREAM_DEFAULTS)', () => {
    const { config } = resolveConfig(TEST_CONFIG);
    expect(config.oauthUpstream).toBeUndefined();
    // 装配缺省形状自洽:超时/次数/间隔均为正整数
    expect(OAUTH_UPSTREAM_DEFAULTS.timeoutMs).toBeGreaterThan(0);
    expect(OAUTH_UPSTREAM_DEFAULTS.attempts).toBeGreaterThanOrEqual(1);
    expect(OAUTH_UPSTREAM_DEFAULTS.retryDelayMs).toBeGreaterThanOrEqual(0);
  });

  it('提供且界内 → 原样透传到 resolved', () => {
    const oauthUpstream = { timeoutMs: 8_000, attempts: 3, retryDelayMs: 500 };
    const { config } = resolveConfig({ ...TEST_CONFIG, oauthUpstream });
    expect(config.oauthUpstream).toEqual(oauthUpstream);
  });

  it('越界拒绝:timeoutMs 下界 / attempts 上界 / retryDelayMs 负值', () => {
    expect(
      fieldOf(() =>
        resolveConfig({
          ...TEST_CONFIG,
          oauthUpstream: { timeoutMs: 999, attempts: 2, retryDelayMs: 0 },
        }),
      ),
    ).toBe('identity.invalid_input:oauthUpstream.timeoutMs');
    expect(
      fieldOf(() =>
        resolveConfig({
          ...TEST_CONFIG,
          oauthUpstream: { timeoutMs: 5_000, attempts: 5, retryDelayMs: 0 },
        }),
      ),
    ).toBe('identity.invalid_input:oauthUpstream.attempts');
    expect(
      fieldOf(() =>
        resolveConfig({
          ...TEST_CONFIG,
          oauthUpstream: { timeoutMs: 5_000, attempts: 2, retryDelayMs: -1 },
        }),
      ),
    ).toBe('identity.invalid_input:oauthUpstream.retryDelayMs');
  });
});
