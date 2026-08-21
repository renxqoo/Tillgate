import { describe, expect, it } from 'vitest';
import { defineAdapter } from '../../src/registry/define-adapter.js';
import { AzureOpenAIAdapter, AZURE_API_VERSION } from '../../src/adapters/azure-openai.js';
import { OpenAICompatibleAdapter } from '../../src/adapters/openai-compatible.js';
import { SUPPORTED_PROTOCOLS } from '../../src/create-ai.js';

const channel = { baseUrl: 'https://up.test', apiKey: 'sk-x', protocol: 'test-proto' };

/** codec 件验证用的透传函数（模块级——避免每次调用重建闭包） */
const translateFn = (b: unknown): { translated: unknown } => ({ translated: b });

describe('defineAdapter 组合器', () => {
  it('未覆写件落 OpenAI 兼容默认（委托而非复制）', () => {
    const adapter = defineAdapter({
      protocol: 'test-proto',
      addressing: {
        planRequest: () => ({ path: '/custom/path', headers: { authorization: 'Bearer x' } }),
      },
    });
    // 寻址被覆写
    const plan = adapter.planRequest(channel, {
      endpoint: 'chat', model: 'm', requestId: 'r', stream: false,
    });
    expect(plan.path).toBe('/custom/path');
    // 抹平引擎/终改/usage/错误映射 = openai-compatible 默认行为
    const smoothed = adapter.normalizeRequest(
      { model: 'm', temperature: 3 },
      { clamp: { temperature: { max: 2 } } },
    );
    expect(smoothed.body).toEqual({ model: 'm', temperature: 2 });
    expect(smoothed.adjustments).toEqual([
      { param: 'temperature', action: 'clamp', from: 3, to: 2 },
    ]);
    const finalized = adapter.finalizeRequestBody({ model: 'ext', messages: [] }, {
      endpoint: 'chat', model: 'real-model', stream: true,
    });
    expect(finalized.model).toBe('real-model');
    expect(finalized.stream_options).toEqual({ include_usage: true, continuous_usage_stats: true });
    expect(adapter.extractUsage({ usage: { prompt_tokens: 1, completion_tokens: 2 } })).toMatchObject({
      inputTokens: 1,
      outputTokens: 2,
    });
    expect(adapter.mapError(429, { error: { message: 'rate limit' } }).code).toBe('rate_limited');
    // 探测请求默认 /v1/models + Bearer
    expect(adapter.probeRequests(channel)).toEqual([
      { path: '/v1/models', headers: { authorization: 'Bearer sk-x' } },
    ]);
  });

  it('partial body 覆写只换终改，抹平引擎仍默认', () => {
    const adapter = defineAdapter({
      protocol: 'test-proto',
      body: {
        finalizeRequestBody: (body) => ({ ...body, vendor_flag: true }),
      },
    });
    const smoothed = adapter.normalizeRequest({ model: 'm', bad: 1 }, { ignore: ['bad'] });
    expect(smoothed.body).toEqual({ model: 'm' });
    expect(adapter.finalizeRequestBody({ model: 'm' }, { endpoint: 'chat', model: 'm', stream: false })).toEqual({
      model: 'm',
      vendor_flag: true,
    });
  });

  it('Azure 组合式适配器与默认注册表兼容（寻址部署制，其余默认）', () => {
    expect(AzureOpenAIAdapter.protocol).toBe('azure-openai');
    const plan = AzureOpenAIAdapter.planRequest(
      { baseUrl: 'https://x.openai.azure.com', apiKey: 'k', protocol: 'azure-openai' },
      { endpoint: 'chat', model: 'my-deploy', requestId: 'req-1', stream: false },
    );
    expect(plan.path).toBe(`/openai/deployments/my-deploy/chat/completions?api-version=${AZURE_API_VERSION}`);
    expect(plan.headers['api-key']).toBe('k');
    expect(plan.headers['idempotency-key']).toBe('req-1');
    // Azure 仍是默认注册表成员
    expect(SUPPORTED_PROTOCOLS).toContain('azure-openai');
  });

  it('codec/tasks 件透传挂载', () => {
    const adapter = defineAdapter({
      protocol: 'test-proto',
      codec: { translateResponseBody: translateFn },
    });
    expect(adapter.translateResponseBody?.({ a: 1 })).toEqual({ translated: { a: 1 } });
    expect(adapter.translateUpstreamStream).toBeUndefined();
  });

  it('默认件委托的单一大象：OpenAICompatibleAdapter 行为不因组合而漂移', () => {
    // 覆写寻址后的适配器抹平行为应与原生 OpenAICompatibleAdapter 逐字一致
    const direct = new OpenAICompatibleAdapter().normalizeRequest(
      { model: 'm', x: 1 },
      { map: { x: { to: 'y' } } },
    );
    const composed = defineAdapter({ protocol: 'p' }).normalizeRequest(
      { model: 'm', x: 1 },
      { map: { x: { to: 'y' } } },
    );
    expect(composed).toEqual(direct);
  });
});
