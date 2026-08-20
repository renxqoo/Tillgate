import { describe, expect, it } from 'vitest';
import { DashScopeAdapter } from '../../src/adapters/dashscope.js';
import { SUPPORTED_PROTOCOLS } from '../../src/index.js';

/**
 * DashScope 原生协议适配器（qwen-image 等图片生成族）：
 * 背景——DashScope 兼容模式不提供 /v1/images/generations（直连 404，2026-08-21 实测），
 * qwen-image 只能走原生 multimodal-generation 同步 API（messages 形 + X-DashScope 异步头不支持新 key）。
 * 线格式：请求 {model, input.messages[].content[].text, parameters.{size,n}}，
 * 响应 output.choices[].message.content[].image + usage.image_count。
 */

const adapter = new DashScopeAdapter();

const channel = { baseUrl: 'https://dashscope.aliyuncs.com', apiKey: 'sk-test' } as never;

describe('DashScopeAdapter.planRequest', () => {
  it('images 端点 → 原生 multimodal-generation 路径 + Bearer', () => {
    const plan = adapter.planRequest(channel, {
      endpoint: 'images',
      model: 'qwen-image',
      requestId: 'req-1',
      stream: false,
    });
    expect(plan.path).toBe('/api/v1/services/aigc/multimodal-generation/generation');
    expect(plan.headers.authorization).toBe('Bearer sk-test');
  });

  it('chat 族端点 → compatible-mode 路径（同协议可服务文本模型）', () => {
    const plan = adapter.planRequest(channel, {
      endpoint: 'chat',
      model: 'qwen-max',
      requestId: 'req-2',
      stream: false,
    });
    expect(plan.path).toBe('/compatible-mode/v1/chat/completions');
  });

  it('探测：compatible-mode /models（轻量鉴权验证）', () => {
    const probes = adapter.probeRequests(channel);
    expect(probes[0]!.path).toBe('/compatible-mode/v1/models');
  });
});

describe('DashScopeAdapter.finalizeRequestBody（images：OpenAI 形 → DashScope 形）', () => {
  const input = { endpoint: 'images' as const, model: 'qwen-image', stream: false };

  it('prompt → input.messages[].content[].text；model 重写为真实名', () => {
    const out = adapter.finalizeRequestBody(
      { model: 'qwen-image-33', prompt: '一只柴犬', n: 1, size: '1024*1024' },
      input,
    );
    expect(out).toEqual({
      model: 'qwen-image',
      input: { messages: [{ role: 'user', content: [{ text: '一只柴犬' }] }] },
      parameters: { n: 1, size: '1024*1024' },
    });
  });

  it('非 images 端点：落 OpenAI 兼容终改（stream_options 注入语义保留）', () => {
    const out = adapter.finalizeRequestBody(
      { model: 'ext', messages: [{ role: 'user', content: 'hi' }] },
      { endpoint: 'chat', model: 'qwen-max', stream: false },
    );
    expect(out.model).toBe('qwen-max');
  });
});

describe('DashScopeAdapter.translateResponseBody（DashScope 形 → OpenAI images 规范形）', () => {
  it('单图：content[].image → data[].url；image_count 进 usage；宽高回填 size', () => {
    const out = adapter.translateResponseBody({
      output: {
        choices: [
          { finish_reason: 'stop', message: { role: 'assistant', content: [{ image: 'https://oss/a.png' }] } },
        ],
      },
      usage: { height: 1024, image_count: 1, width: 1024 },
      request_id: 'r-1',
    }) as { data: Array<{ url: string; size?: string }>; usage: Record<string, number> };
    expect(out.data).toEqual([{ url: 'https://oss/a.png', size: '1024*1024' }]);
    expect(out.usage.image_count).toBe(1);
  });

  it('多图（n>1）：content 数组多元素 → data 多元素', () => {
    const out = adapter.translateResponseBody({
      output: {
        choices: [
          { message: { content: [{ image: 'https://oss/1.png' }, { image: 'https://oss/2.png' }] } },
        ],
      },
      usage: { image_count: 2 },
    }) as { data: string[] };
    expect(out.data).toHaveLength(2);
  });

  it('幂等兜底：非 DashScope 形（已规范形/错误体）原样返回', () => {
    const body = { object: 'list', data: [{ url: 'x' }] };
    expect(adapter.translateResponseBody(body)).toBe(body);
  });
});

describe('DashScopeAdapter.extractUsage', () => {
  it('规范形 usage.image_count → units（按张计费的计数源）', () => {
    const usage = adapter.extractUsage({ usage: { image_count: 3, input_tokens: 0, output_tokens: 0 } });
    expect(usage?.units).toBe(3);
    expect(usage?.inputTokens).toBe(0);
    expect(usage?.outputTokens).toBe(0);
  });

  it('无 image_count（chat 族）：落 OpenAI usage 归一', () => {
    const usage = adapter.extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    expect(usage?.inputTokens).toBe(10);
    expect(usage?.outputTokens).toBe(5);
  });
});

describe('DashScopeAdapter 注册', () => {
  // SUPPORTED_PROTOCOLS 由 defaultAdapters 派生（单一真相）：
  // 含 dashscope ⇒ 已注册进默认注册表，admin 协议校验随之放行
  it('SUPPORTED_PROTOCOLS 含 dashscope（admin 协议下拉单一真相）', () => {
    expect(SUPPORTED_PROTOCOLS).toContain('dashscope');
  });
});

describe('DashScopeAdapter.mapError', () => {
  it('DashScope 错误体 {code,message} → UpstreamError 透传 code', () => {
    const err = adapter.mapError(400, { code: 'InvalidParameter', message: 'Model not exist.', request_id: 'r' });
    expect(err.status).toBe(400);
    expect(err.retryable).toBe(false);
  });
});
