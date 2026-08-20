import { describe, expect, it } from 'vitest';
import { AnthropicAdapter, ANTHROPIC_VERSION } from '../../src/adapters/anthropic.js';

/** AnthropicAdapter 寻址/usage/探测/错误映射（流翻译由 native-protocol-adapters 覆盖） */
describe('AnthropicAdapter', () => {
  const adapter = new AnthropicAdapter();
  const channel = { baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant', protocol: 'anthropic' };

  it('寻址：/v1/messages + x-api-key + anthropic-version；流式同路径（stream 在体里）', () => {
    for (const stream of [false, true]) {
      const plan = adapter.planRequest(channel, {
        endpoint: 'chat', model: 'claude-x', requestId: 'r1', stream,
      });
      expect(plan.path).toBe('/v1/messages');
      expect(plan.headers).toEqual({
        'x-api-key': 'sk-ant',
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
        'idempotency-key': 'r1',
      });
    }
  });

  it('extractUsage：规范形 usage 提取（cache_read → cached）', () => {
    const u = adapter.extractUsage({
      usage: { prompt_tokens: 9, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } },
    });
    expect(u).toMatchObject({ inputTokens: 9, outputTokens: 2, cachedInputTokens: 4 });
    expect(adapter.extractUsage({})).toBeNull();
  });

  it('probeRequests：/v1/models + x-api-key', () => {
    const probes = adapter.probeRequests(channel);
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatchObject({ path: '/v1/models', headers: { 'x-api-key': 'sk-ant' } });
  });

  it('mapError：委托分类矩阵（429 → rate_limited）', () => {
    expect(adapter.mapError(429, { error: { message: 'rate limit' } }).code).toBe('rate_limited');
  });
});
