import { describe, expect, it } from 'vitest';
import {
  estimateTokens,
  extractRequestChars,
  extractResponseChars,
  normalizeUsage,
} from '../../src/usage/normalize.js';

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

describe('extractRequestChars', () => {
  it('messages.content 字符串累加', () => {
    const n = extractRequestChars({
      messages: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: 'world' },
      ],
    });
    expect(n).toBe(7); // 2 + 5
  });

  it('messages.content 多模态数组（取 text 长度）', () => {
    const n = extractRequestChars({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'abc' }, { type: 'image_url' }] },
      ],
    });
    expect(n).toBe(3);
  });

  it('tools 定义体纳入估算（企业 Agent 主要输入消耗源）', () => {
    const tools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }];
    const n = extractRequestChars({ messages: [{ role: 'user', content: 'hi' }], tools });
    expect(n).toBeGreaterThan(2); // content(2) + tools JSON 长度
  });

  it('非对象 body 返回 0', () => {
    expect(extractRequestChars('plain')).toBe(0);
    expect(extractRequestChars(null)).toBe(0);
  });

  it('无 messages 返回 0（仅 tools 仍计）', () => {
    const n = extractRequestChars({ tools: [{ function: { name: 'x' } }] });
    expect(n).toBeGreaterThan(0);
  });
});

describe('extractResponseChars', () => {
  it('content 字符串', () => {
    expect(extractResponseChars({ choices: [{ message: { content: 'hello' } }] })).toBe(5);
  });

  it('tool_calls.arguments 纳入估算（纯工具调用 content=null 不再返回 0）', () => {
    const n = extractResponseChars({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: 'call_1', function: { name: 'get_weather', arguments: '{"city":"北京"}' } },
            ],
          },
        },
      ],
    });
    // arguments 字符串长度 16（{"city":"北京"}，中文算 1 字符 .length）
    expect(n).toBe('{"city":"北京"}'.length);
  });

  it('content + tool_calls 同时存在累加', () => {
    const n = extractResponseChars({
      choices: [
        {
          message: {
            content: 'abc',
            tool_calls: [{ function: { arguments: '{"x":1}' } }],
          },
        },
      ],
    });
    expect(n).toBe(3 + '{"x":1}'.length);
  });

  it('补全类响应（text 字段）', () => {
    expect(extractResponseChars({ choices: [{ text: 'hi' }] })).toBe(2);
  });

  it('空 choices / 无 message 返回 0', () => {
    expect(extractResponseChars({})).toBe(0);
    expect(extractResponseChars({ choices: [] })).toBe(0);
    expect(extractResponseChars({ choices: [{ message: {} }] })).toBe(0);
  });
});
