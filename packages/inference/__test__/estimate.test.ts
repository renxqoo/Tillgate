import { describe, expect, it } from 'vitest';
import {
  estimateInputTokensOfBody,
  estimateTokensFromFeatures,
  estimateTokensFromText,
} from '../src/domain/usage/estimate';

const weights = {
  cjkTokensPerChar: 0.7,
  tokensPerWord: 1.1,
  tokensPerNumber: 1.0,
  tokensPerSymbol: 1.0,
};

describe('domain/usage/estimate：特征四计数器 → token 估算（C1 口径）', () => {
  it('空文本 0；纯 CJK 按 0.7/字向上取整', () => {
    expect(estimateTokensFromText('', weights)).toBe(0);
    expect(estimateTokensFromText('你好世界', weights)).toBe(3); // 4 × 0.7 = 2.8 → ceil 3
  });

  it('混合文本：CJK + 词段 + 数字段 + 符号加权（与 ai 特征计数器对齐）', () => {
    // "hello world 你好 42!" → 2 词段 + 2 CJK + 1 数字段 + 1 符号（空格不计）
    const tokens = estimateTokensFromText('hello world 你好 42!', weights);
    expect(tokens).toBe(Math.ceil(2 * 1.1 + 2 * 0.7 + 1 * 1.0 + 1 * 1.0));
  });

  it('特征直供路径（流终态 outputFeatures）：与文本路径同系数', () => {
    const features = { cjkChars: 10, wordSegments: 5, numberSegments: 2, symbolCount: 3 };
    expect(estimateTokensFromFeatures(features, weights)).toBe(
      Math.ceil(10 * 0.7 + 5 * 1.1 + 2 * 1.0 + 3 * 1.0),
    );
    expect(
      estimateTokensFromFeatures(
        { cjkChars: 0, wordSegments: 0, numberSegments: 0, symbolCount: 0 },
        weights,
      ),
    ).toBe(0);
  });

  it('系数装配可调（0 系数 → 0 token；缺省口径不被硬编码）', () => {
    const zero = { cjkTokensPerChar: 0, tokensPerWord: 0, tokensPerNumber: 0, tokensPerSymbol: 0 };
    expect(estimateTokensFromText('hello 你好 42', zero)).toBe(0);
    const heavy = { ...weights, cjkTokensPerChar: 2 };
    expect(estimateTokensFromText('你好', heavy)).toBe(4);
  });

  it('请求体估算：序列化文本过特征估算；序列化失败兜底 0（不抛不崩）', () => {
    expect(estimateInputTokensOfBody({ messages: [{ content: '你好' }] }, weights)).toBeGreaterThan(
      0,
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(estimateInputTokensOfBody(cyclic, weights)).toBe(0);
  });
});
