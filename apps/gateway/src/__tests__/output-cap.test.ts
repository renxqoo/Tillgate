import { describe, expect, it } from 'vitest';
import {
  clampForwardedOutputLimit,
  conservativeInputTokenUpperBound,
} from '../pipeline/output-cap.js';

describe('计费敞口硬上界', () => {
  it('客户端未声明输出上限时注入 max_completion_tokens', () => {
    expect(clampForwardedOutputLimit({ model: 'x' }, 4096)).toEqual({
      model: 'x',
      max_completion_tokens: 4096,
    });
  });

  it('n 个 completion 按单路额度钳制', () => {
    expect(clampForwardedOutputLimit({ n: 4, max_tokens: 9000 }, 4000)).toMatchObject({
      max_tokens: 1000,
    });
  });

  it('输入预留不低于完整 JSON 的 UTF-8 字节上界', () => {
    const body = { messages: [{ role: 'user', content: '资金安全' }] };
    const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
    expect(conservativeInputTokenUpperBound(body, 1)).toBe(bytes);
  });
});
