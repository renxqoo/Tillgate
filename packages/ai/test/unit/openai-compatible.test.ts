import { describe, expect, it } from 'vitest';
import { OpenAICompatibleAdapter } from '../../src/adapters/openai-compatible.js';

const adapter = new OpenAICompatibleAdapter();

describe('OpenAICompatibleAdapter.normalizeRequest', () => {
  it('无规则：原样透传（透传为基底）', () => {
    const req = { model: 'deepseek-chat', temperature: 1.5 };
    const { body, adjustments } = adapter.normalizeRequest(req, {});
    expect(body).toEqual(req);
    expect(adjustments).toEqual([]);
  });

  it('ignore：删除不支持参数并记录', () => {
    const { body, adjustments } = adapter.normalizeRequest(
      { model: 'deepseek-reasoner', temperature: 0.7, top_p: 1 },
      { ignore: ['temperature'] },
    );
    expect(body).toEqual({ model: 'deepseek-reasoner', top_p: 1 });
    expect(adjustments).toEqual([{ param: 'temperature', action: 'ignore', from: 0.7 }]);
  });

  it('ignore 不存在的参数：无调整', () => {
    const { body, adjustments } = adapter.normalizeRequest({ model: 'x' }, { ignore: ['nope'] });
    expect(body).toEqual({ model: 'x' });
    expect(adjustments).toEqual([]);
  });

  it('map：改名并删除原名', () => {
    const { body, adjustments } = adapter.normalizeRequest(
      { model: 'o3', max_tokens: 2048 },
      { map: { max_tokens: { to: 'max_completion_tokens' } } },
    );
    expect(body).toEqual({ model: 'o3', max_completion_tokens: 2048 });
    expect(adjustments).toEqual([
      { param: 'max_tokens', action: 'map', from: 2048, to: 'max_completion_tokens' },
    ]);
  });

  it('clamp：超上限钳制、未超不动、非数字不动', () => {
    const rules = { clamp: { max_tokens: { max: 8192 } } };
    const over = adapter.normalizeRequest({ max_tokens: 16384 }, rules);
    expect(over.body).toEqual({ max_tokens: 8192 });
    expect(over.adjustments).toEqual([
      { param: 'max_tokens', action: 'clamp', from: 16384, to: 8192 },
    ]);

    const ok = adapter.normalizeRequest({ max_tokens: 1024 }, rules);
    expect(ok.adjustments).toEqual([]);

    const notNum = adapter.normalizeRequest({ max_tokens: 'auto' }, rules);
    expect(notNum.adjustments).toEqual([]);
  });

  it('执行顺序：map 在 clamp 前（clamp 作用于最终参数名）', () => {
    const { body, adjustments } = adapter.normalizeRequest(
      { max_tokens: 100000 },
      {
        map: { max_tokens: { to: 'max_completion_tokens' } },
        clamp: { max_completion_tokens: { max: 8192 } },
      },
    );
    expect(body).toEqual({ max_completion_tokens: 8192 });
    expect(adjustments).toEqual([
      { param: 'max_tokens', action: 'map', from: 100000, to: 'max_completion_tokens' },
      { param: 'max_completion_tokens', action: 'clamp', from: 100000, to: 8192 },
    ]);
  });

  it('unknown: drop 删除未知参数，保留已知与 map 目标名', () => {
    const req = {
      model: 'x',
      messages: [],
      temperature: 0.5,
      custom_field: 1,
      max_tokens: 10,
    };
    const { body, adjustments } = adapter.normalizeRequest(req, {
      map: { max_tokens: { to: 'max_completion_tokens' } },
      unknown: 'drop',
    });
    expect(body).toEqual({ model: 'x', messages: [], temperature: 0.5, max_completion_tokens: 10 });
    expect(adjustments).toEqual([
      { param: 'max_tokens', action: 'map', from: 10, to: 'max_completion_tokens' },
      { param: 'custom_field', action: 'ignore', from: 1 },
    ]);
  });

  it('unknown 默认 passthrough（未知参数保留）', () => {
    const { body } = adapter.normalizeRequest({ model: 'x', custom_field: 1 }, {});
    expect(body).toEqual({ model: 'x', custom_field: 1 });
  });

  it('非对象请求：原样返回不破坏', () => {
    const { body, adjustments } = adapter.normalizeRequest('plain-string', { ignore: ['a'] });
    expect(body).toBe('plain-string');
    expect(adjustments).toEqual([]);
  });

  it('不修改原始请求对象（浅拷贝语义）', () => {
    const req = { model: 'x', temperature: 1 };
    adapter.normalizeRequest(req, { clamp: { temperature: { max: 0.5 } } });
    expect(req).toEqual({ model: 'x', temperature: 1 });
  });
});

describe('OpenAICompatibleAdapter.extractUsage', () => {
  it('OpenAI 风格 cached_tokens 归一化', () => {
    const usage = adapter.extractUsage({
      usage: {
        prompt_tokens: 100,
        prompt_tokens_details: { cached_tokens: 40 },
        completion_tokens: 20,
      },
    });
    expect(usage).toMatchObject({
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 20,
      estimated: false,
    });
  });

  it('DeepSeek 风格 cache_hit 优先', () => {
    const usage = adapter.extractUsage({
      usage: {
        prompt_tokens: 100,
        prompt_cache_hit_tokens: 60,
        prompt_cache_miss_tokens: 40,
        completion_tokens: 20,
      },
    });
    expect(usage).toMatchObject({ inputTokens: 100, cachedInputTokens: 60 });
  });

  it('无 usage 返回 null（调用方按字符估算）', () => {
    expect(adapter.extractUsage({ choices: [] })).toBeNull();
    expect(adapter.extractUsage('not-object')).toBeNull();
  });
});

describe('OpenAICompatibleAdapter.mapError', () => {
  it('委托分类矩阵：401 死凭据', () => {
    const err = adapter.mapError(401, { error: { message: 'Invalid API key' } });
    expect(err.code).toBe('invalid_api_key');
    expect(err.deadCredential).toBe(true);
    expect(err.retryable).toBe(false);
  });

  it('委托分类矩阵：429 rate_limited', () => {
    const err = adapter.mapError(429, { error: { message: 'slow down' } });
    expect(err.code).toBe('rate_limited');
    expect(err.retryable).toBe(true);
    expect(err.circuitTrip).toBe(false);
  });

  it('委托分类矩阵：500 跳闸', () => {
    const err = adapter.mapError(500, { error: { message: 'boom' } });
    expect(err.circuitTrip).toBe(true);
  });
});

describe('OpenAICompatibleAdapter.planRequest', () => {
  it('chat 端点 → /v1/chat/completions,Bearer + content-type + idempotency-key', () => {
    const plan = adapter.planRequest(
      { baseUrl: 'http://u', apiKey: 'sk-1', protocol: 'openai-compatible' },
      { endpoint: 'chat', model: 'm', requestId: 'r-1' },
    );
    expect(plan.path).toBe('/v1/chat/completions');
    expect(plan.headers).toEqual({
      authorization: 'Bearer sk-1',
      'content-type': 'application/json',
      'idempotency-key': 'r-1',
    });
  });

  it('embeddings 端点 → /v1/embeddings', () => {
    const plan = adapter.planRequest(
      { baseUrl: 'http://u', apiKey: 'sk-1', protocol: 'openai-compatible' },
      { endpoint: 'embeddings', model: 'm', requestId: 'r-1' },
    );
    expect(plan.path).toBe('/v1/embeddings');
  });
});

describe('OpenAICompatibleAdapter.finalizeRequestBody', () => {
  it('model 重写为真实模型名', () => {
    const out = adapter.finalizeRequestBody(
      { model: 'external-name', messages: [] },
      { endpoint: 'chat', model: 'real-name', stream: false },
    );
    expect(out.model).toBe('real-name');
  });

  it('非流式不注入 stream_options', () => {
    const out = adapter.finalizeRequestBody(
      { model: 'm', messages: [] },
      { endpoint: 'chat', model: 'm', stream: false },
    );
    expect('stream_options' in out).toBe(false);
  });

  it('流式强制注入 include_usage + continuous_usage_stats,保留用户键并覆盖 include_usage:false', () => {
    const out = adapter.finalizeRequestBody(
      { model: 'm', stream: true, stream_options: { custom_flag: true, include_usage: false } },
      { endpoint: 'chat', model: 'm', stream: true },
    );
    expect(out.stream_options).toEqual({
      custom_flag: true,
      include_usage: true,
      continuous_usage_stats: true,
    });
  });
});

describe('OpenAICompatibleAdapter.probeRequests', () => {
  it('优先 /v1/models（GET 无副作用，Bearer 认证）', () => {
    const probes = adapter.probeRequests({
      baseUrl: 'http://u',
      apiKey: 'sk-1',
      protocol: 'openai-compatible',
    });
    expect(probes).toEqual([{ path: '/v1/models', headers: { authorization: 'Bearer sk-1' } }]);
  });
});
