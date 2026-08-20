/**
 * 【红测】estimateOutputTokens 未把 model 传给估算器（review 2026-08-20）——预期失败：
 *
 * token-estimate.ts 的估算单一真相是 countText = BPE 真分词器主路径 + 启发式兜底。
 * estimateInputTokens 对 messages.content 正确传了 model（走 BPE）；estimateOutputTokens
 * 对 choices[].message.content 调 estimateContent 时漏传 model（token-estimate.ts
 * `estimateContent(message.content, weights)`）→ 输出侧恒走启发式兜底。
 *
 * 资金影响：非流式响应缺 usage 时（estimatedFor='usage_missing_nonstream'，估算结算），
 * 输出 token 与输入 token 采用两套口径——同一文本计价基础不一致（实测 200 字 CJK：
 * 输入侧 BPE=100、输出侧启发式=140，偏差 +40%）；偏差方向随文本构成漂移（代码/生僻
 * 文本反向低估），估算扣费金额系统性偏离。
 *
 * 修复后本文件应转绿（断言的是「同一文本同一估算器」的契约，不是具体数值快照）。
 */
import { describe, expect, it } from 'vitest';
import {
  estimateInputTokens,
  estimateOutputTokens,
  estimateTextTokens,
} from '../../src/usage/token-estimate.js';

describe('estimateOutputTokens 应与输入侧同口径（BPE 主路径，传 model）', () => {
  const cjkText = '你好世界'.repeat(50); // 200 字 CJK
  const mixedText = '总结以下代码并给出重构建议：function foo(a,b){return a+b;} 请用中文回答。'.repeat(10);

  for (const [name, text] of [['CJK 文本', cjkText], ['代码混合文本', mixedText]] as const) {
    it(`${name}：同一文本 content 在输入侧与输出侧的估算应相等（单一估算器）`, () => {
      const inputSide = estimateInputTokens(
        { messages: [{ role: 'user', content: text }] },
        { model: 'gpt-4o' },
      );
      const outputSide = estimateOutputTokens(
        { choices: [{ message: { role: 'assistant', content: text } }] },
        { model: 'gpt-4o' },
      );
      expect(
        outputSide,
        `传了 model 的输出估算应走与输入侧相同的 BPE 路径（input=${inputSide}, output=${outputSide}）；` +
          `若 output ≈ 启发式值 ${estimateTextTokens(text)} 则说明 model 未透传给 estimateContent`,
      ).toBe(inputSide);
    });
  }

  it('无 model 时两侧允许回落启发式（兜底语义不变，仅证明差异来自 model 漏传）', () => {
    const inputSide = estimateInputTokens({ messages: [{ role: 'user', content: cjkText }] });
    const outputSide = estimateOutputTokens({ choices: [{ message: { role: 'assistant', content: cjkText } }] });
    expect(outputSide).toBe(inputSide);
  });
});
