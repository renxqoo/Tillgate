import { describe, expect, it } from 'vitest';
import { estimateTokens, normalizeUsage } from '../../src/usage/normalize.js';

describe('normalizeUsage', () => {
  it('OpenAI 风格：cached_tokens → cachedInputTokens', () => {
    const u = normalizeUsage({
      prompt_tokens: 10,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 4 },
    });
    expect(u).toEqual({
      inputTokens: 10,
      cachedInputTokens: 4,
      outputTokens: 20,
      estimated: false,
      raw: expect.anything(),
    });
  });

  it('DeepSeek 风格：cache_hit/cache_miss', () => {
    const u = normalizeUsage({
      prompt_tokens: 100,
      prompt_cache_hit_tokens: 80,
      prompt_cache_miss_tokens: 20,
      completion_tokens: 30,
    });
    expect(u?.inputTokens).toBe(100);
    expect(u?.cachedInputTokens).toBe(80);
    expect(u?.outputTokens).toBe(30);
  });

  it('DeepSeek 无 prompt_tokens 时由 hit+miss 推算', () => {
    const u = normalizeUsage({
      prompt_cache_hit_tokens: 5,
      prompt_cache_miss_tokens: 3,
      completion_tokens: 1,
    });
    expect(u?.inputTokens).toBe(8);
    expect(u?.cachedInputTokens).toBe(5);
  });

  it('无缓存字段 → cachedInputTokens = 0', () => {
    const u = normalizeUsage({ prompt_tokens: 7, completion_tokens: 3 });
    expect(u?.cachedInputTokens).toBe(0);
  });

  it('字符串数字兼容', () => {
    const u = normalizeUsage({ prompt_tokens: '10', completion_tokens: '20' });
    expect(u?.inputTokens).toBe(10);
  });

  it('usage 缺失/无意义 → null', () => {
    expect(normalizeUsage(null)).toBeNull();
    expect(normalizeUsage(undefined)).toBeNull();
    expect(normalizeUsage({ foo: 1 })).toBeNull();
    expect(normalizeUsage('nope')).toBeNull();
  });
});

describe('estimateTokens', () => {
  it('按 charPerToken 上取整', () => {
    expect(estimateTokens(35, 3.5)).toBe(10);
    expect(estimateTokens(36, 3.5)).toBe(11);
  });

  it('最小为 1（空内容也计 1 token 兜底）', () => {
    expect(estimateTokens(0, 3.5)).toBe(1);
  });
});
