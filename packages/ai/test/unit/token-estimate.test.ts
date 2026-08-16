import { describe, expect, it } from 'vitest';
import {
  estimateInputTokens,
  estimateOutputTokens,
  estimateTextTokens,
  estimateUsage,
  extractTextFeatures,
} from '../../src/usage/token-estimate.js';
import type { TextTokenWeights } from '../../src/usage/calibration.js';

/**
 * token 估算单一真相（token-estimate.ts）：
 *   - extractTextFeatures：字符分类（CJK/单词/数字/符号）单一真相
 *   - estimateTextTokens = 特征 × 权重；estimateInputTokens/estimateOutputTokens 结构提取
 *   - estimateUsage：usage 缺失兜底（estimated=true，全部按未缓存计，非计费诊断值）
 *
 * 权重来自 calibration（默认 CJK 0.7 / word 1.1 / number 1.0 / symbol 1.0，2026-08 实测）。
 * 分类正确性用「全 1 权重」验证，数值用默认权重验证。
 */

/** 全 1 权重：验证分类（每类字符计 1） */
const UNIT: TextTokenWeights = { cjk: 1.0, word: 1.0, number: 1.0, symbol: 1.0 };

describe('embeddings token-id 数组估算', () => {
  it('number[] / number[][] input 按 id 数计入（不低估）', () => {
    const flat = estimateInputTokens({ model: 'm', input: [1, 2, 3] });
    expect(flat).toBeGreaterThanOrEqual(3);
    const batched = estimateInputTokens({ model: 'm', input: [[1, 2], [3, 4, 5]] });
    expect(batched).toBeGreaterThanOrEqual(5);
  });
});

describe('extractTextFeatures', () => {
  it('分类：CJK / 单词段 / 数字段 / 符号', () => {
    expect(extractTextFeatures('你好')).toEqual({
      cjkChars: 2,
      wordSegments: 0,
      numberSegments: 0,
      symbolCount: 0,
    });
    expect(extractTextFeatures('hello world')).toEqual({
      cjkChars: 0,
      wordSegments: 2,
      numberSegments: 0,
      symbolCount: 0,
    });
    expect(extractTextFeatures('a1 b2')).toEqual({
      cjkChars: 0,
      wordSegments: 2,
      numberSegments: 2,
      symbolCount: 0,
    });
    expect(extractTextFeatures('{a:1, b:2}')).toEqual({
      cjkChars: 0,
      wordSegments: 2,
      numberSegments: 2,
      symbolCount: 5, // { : , : }
    });
  });

  it('emoji/astral 按 1 个 code point 计（不因 UTF-16 双计）', () => {
    expect(extractTextFeatures('😀')).toEqual({
      cjkChars: 0,
      wordSegments: 0,
      numberSegments: 0,
      symbolCount: 1,
    });
  });

  it('空文本全 0', () => {
    expect(extractTextFeatures('')).toEqual({
      cjkChars: 0,
      wordSegments: 0,
      numberSegments: 0,
      symbolCount: 0,
    });
  });
});

describe('estimateTextTokens（分类正确性，全 1 权重）', () => {
  it('中文逐字', () => {
    expect(estimateTextTokens('你好', UNIT)).toBe(2);
    expect(estimateTextTokens('你好世界', UNIT)).toBe(4);
  });

  it('英文按词', () => {
    expect(estimateTextTokens('hello world', UNIT)).toBe(2);
    expect(estimateTextTokens('hello fallback pricing', UNIT)).toBe(3);
  });

  it('中日韩混排逐字累计', () => {
    expect(estimateTextTokens('你好 world', UNIT)).toBe(3);
  });

  it('标点/符号每个计 1，空白不计', () => {
    expect(estimateTextTokens('hello, world!', UNIT)).toBe(4);
    expect(estimateTextTokens('a b', UNIT)).toBe(2);
  });

  it('数字段单独计（区别于单词段）', () => {
    expect(estimateTextTokens('abc 123 xyz', UNIT)).toBe(3); // 2 单词 + 1 数字段
  });

  it('空文本返回 0', () => {
    expect(estimateTextTokens('', UNIT)).toBe(0);
    expect(estimateTextTokens('   ', UNIT)).toBe(0);
  });
});

describe('estimateTextTokens（默认权重 0.7/1.1/1.0/1.0）', () => {
  it('中文按 0.7 token/字（实测 1.5 字/token，不再 1 字=1 token）', () => {
    expect(estimateTextTokens('你好')).toBe(1); // 2 × 0.7 = 1.4 → 1
    expect(estimateTextTokens('你好世界')).toBe(3); // 4 × 0.7 = 2.8 → 3
  });

  it('英文按 1.1 token/词（实测 ~1.15）', () => {
    expect(estimateTextTokens('hello world')).toBe(2); // 2 × 1.1 = 2.2 → 2
    expect(estimateTextTokens('hello fallback pricing')).toBe(3); // 3 × 1.1 = 3.3 → 3
  });
});

describe('estimateInputTokens', () => {
  it('messages.content 字符串累加', () => {
    const n = estimateInputTokens({
      messages: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: 'world' },
      ],
    });
    expect(n).toBe(2); // 你好(1) + world(1)
  });

  it('messages.content 多模态数组（取 text part）', () => {
    const n = estimateInputTokens({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'abc' }] }],
    });
    expect(n).toBe(1);
  });

  it('媒体 part（image_url/audio 等）给保守非零下限', () => {
    const n = estimateInputTokens({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '看图' },
            { type: 'image_url', image_url: { url: 'https://x/a.png' } },
          ],
        },
      ],
    });
    expect(n).toBeGreaterThanOrEqual(85 + 1); // 1 张图下限 85 + 看图(1)
  });

  it('历史 assistant tool_calls（name + arguments）计入输入', () => {
    const n = estimateInputTokens({
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', function: { name: 'get_weather', arguments: '{"city":"北京"}' } },
          ],
        },
        { role: 'tool', content: '晴' },
      ],
    });
    expect(n).toBeGreaterThanOrEqual(4);
  });

  it('tools 定义体纳入估算', () => {
    const tools = [
      { type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } },
    ];
    const n = estimateInputTokens({ messages: [{ role: 'user', content: 'hi' }], tools });
    expect(n).toBeGreaterThan(1);
  });

  it('embeddings input 支持单字符串和字符串数组', () => {
    expect(estimateInputTokens({ input: 'hello' })).toBe(1);
    expect(estimateInputTokens({ input: ['hello', 'world'] })).toBe(2);
  });

  it('非对象 body 返回 0', () => {
    expect(estimateInputTokens('plain')).toBe(0);
    expect(estimateInputTokens(null)).toBe(0);
  });
});

describe('estimateOutputTokens', () => {
  it('content 字符串', () => {
    expect(estimateOutputTokens({ choices: [{ message: { content: 'hello' } }] })).toBe(1);
  });

  it('reasoning_content / thinking 计入输出（推理模型主要 token 源）', () => {
    const n = estimateOutputTokens({
      choices: [{ message: { content: 'ok', reasoning_content: '让我思考一下' } }],
    });
    expect(n).toBeGreaterThanOrEqual(1 + 4); // ok(1) + 6 CJK × 0.7 = 4.2 → 4
  });

  it('tool_calls.arguments 计入输出', () => {
    const n = estimateOutputTokens({
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
    expect(n).toBeGreaterThanOrEqual(2);
  });

  it('n > 1 时全量 choices 累加，不再只取 choices[0]', () => {
    const n = estimateOutputTokens({
      choices: [
        { message: { content: 'a' } },
        { message: { content: 'b' } },
        { message: { content: 'c' } },
      ],
    });
    expect(n).toBe(3);
  });

  it('数组型 content（多模态输出）逐 part 取 text', () => {
    const n = estimateOutputTokens({
      choices: [{ message: { content: [{ type: 'text', text: 'hi' }] } }],
    });
    expect(n).toBe(1);
  });

  it('补全类响应 text 字段', () => {
    expect(estimateOutputTokens({ choices: [{ text: 'hi' }] })).toBe(1);
  });

  it('空 choices / 无 message 返回 0', () => {
    expect(estimateOutputTokens({})).toBe(0);
    expect(estimateOutputTokens({ choices: [] })).toBe(0);
    expect(estimateOutputTokens({ choices: [{ message: {} }] })).toBe(0);
  });
});

describe('estimateUsage', () => {
  it('usage 缺失兜底：estimated=true，全部按未缓存计，输入/输出按新估算', () => {
    const usage = estimateUsage(
      { messages: [{ role: 'user', content: '你好' }] },
      { choices: [{ message: { content: '你好' } }] },
    );
    expect(usage.estimated).toBe(true);
    expect(usage.cachedInputTokens).toBe(0);
    expect(usage.inputTokens).toBe(1); // 2 × 0.7 = 1.4 → 1
    expect(usage.outputTokens).toBe(1);
    expect(usage.raw).toBeNull();
  });
});
