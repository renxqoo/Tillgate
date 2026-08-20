import { describe, expect, it } from 'vitest';
import { normalizeUsage } from '../../src/usage/normalize.js';

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

  it('Responses input/output tokens 与缓存明细可归一化', () => {
    expect(
      normalizeUsage({
        input_tokens: 12,
        output_tokens: 3,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 2, audio_tokens: 4 },
        output_tokens_details: { reasoning_tokens: 1 },
      }),
    ).toMatchObject({ inputTokens: 12, cachedInputTokens: 2, outputTokens: 3 });
  });

  it('Mistral 方言：camel 变体（promptTokensDetails/promptTokenDetails/numCachedTokens）可归一', () => {
    const cases: Array<Record<string, unknown>> = [
      { prompt_tokens: 10, completion_tokens: 2, promptTokensDetails: { cachedTokens: 6 } },
      { prompt_tokens: 10, completion_tokens: 2, promptTokenDetails: { cachedTokens: 6 } },
      { prompt_tokens: 10, completion_tokens: 2, numCachedTokens: 6 },
      { prompt_tokens: 10, completion_tokens: 2, num_cached_tokens: '6' },
    ];
    for (const usage of cases) {
      expect(normalizeUsage(usage)).toMatchObject({ inputTokens: 10, cachedInputTokens: 6, outputTokens: 2 });
    }
  });

  it('Mistral 方言：camel 变体间冲突 → 不可信 null', () => {
    expect(
      normalizeUsage({
        prompt_tokens: 10,
        completion_tokens: 2,
        promptTokensDetails: { cachedTokens: 6 },
        promptTokenDetails: { cachedTokens: 7 },
      }),
    ).toBeNull();
  });

  it('冲突、负数、小数、超安全整数、cached 超界和零 usage 均不可信', () => {
    const invalid = [
      { prompt_tokens: 10, input_tokens: 11, completion_tokens: 1 },
      { prompt_tokens: -1, completion_tokens: 1 },
      { prompt_tokens: 1.5, completion_tokens: 1 },
      { prompt_tokens: Number.MAX_SAFE_INTEGER + 1, completion_tokens: 1 },
      { prompt_tokens: 2, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 3 } },
      { prompt_tokens: 0, completion_tokens: 0 },
      { prompt_tokens: 2, completion_tokens: 1, total_tokens: 99 },
    ];
    for (const usage of invalid) expect(normalizeUsage(usage)).toBeNull();
  });
});
