import { describe, expect, it } from 'vitest';
import { estimateStreamUsage } from './stream-usage.js';

/**
 * 流式 usage 缺失时的兜底估算（events.ts 契约 §14）：
 *   success.usage 为空 + bytesRelayed > 0 → gateway 按已透字节估算 tokens
 *
 * 真实驱动场景：MiniMax-M3 流式全程不发 usage（每帧 usage:null），
 * 若不兜底则成功响应却从不结算（漏计费 + hold key 残留）。
 */
describe('estimateStreamUsage', () => {
  it('bytesRelayed=0 → null（完全无输出不计费）', () => {
    expect(estimateStreamUsage({ messages: [{ content: 'hi' }] }, 0)).toBeNull();
  });

  it('bytesRelayed<0 → null（防御负值）', () => {
    expect(estimateStreamUsage({ messages: [{ content: 'hi' }] }, -10)).toBeNull();
  });

  it('bytesRelayed>0 → 按 bytes 估算 outputTokens，标 estimated=true', () => {
    // 90 字节 / 3(UTF-8 平均字节/字符) = 30 字符 → 30/3.5 = 8.57 → ceil = 9 tokens
    const usage = estimateStreamUsage({ messages: [{ content: 'hi' }] }, 90)!;
    expect(usage).not.toBeNull();
    expect(usage.estimated).toBe(true);
    expect(usage.outputTokens).toBe(9);
    expect(usage.cachedInputTokens).toBe(0); // 估算全部按未缓存计
  });

  it('inputTokens 按请求 messages 字符数估算', () => {
    // content "你好世界" = 4 字符 → 4/3.5 = 1.14 → ceil = 2 tokens
    const usage = estimateStreamUsage(
      { messages: [{ content: '你好世界' }] },
      30, // 30 bytes → 10 chars → 3 tokens output
    )!;
    expect(usage.inputTokens).toBe(2);
    expect(usage.outputTokens).toBe(3);
  });

  it('tools 定义体纳入 inputTokens 估算（工具调用主要输入消耗）', () => {
    const bigTools = [{ type: 'function', function: { name: 'x'.repeat(35) } }];
    const usage = estimateStreamUsage(
      { messages: [{ content: 'a' }], tools: bigTools },
      10,
    )!;
    // tools JSON 长度 ~57 + content 1 = 58 字符 → 17 tokens（远大于无 tools 时的 1）
    expect(usage.inputTokens).toBeGreaterThanOrEqual(15);
  });

  it('raw 记录 bytesRelayed + source（审计可追溯估算来源）', () => {
    const usage = estimateStreamUsage({ messages: [{ content: 'hi' }] }, 50)!;
    const raw = usage.raw as { bytesRelayed: number; source: string };
    expect(raw.bytesRelayed).toBe(50);
    expect(raw.source).toBe('gateway_bytes_estimate');
  });

  it('messages 缺失也不崩溃（inputTokens 至少为 1）', () => {
    const usage = estimateStreamUsage({}, 30)!;
    expect(usage.inputTokens).toBeGreaterThanOrEqual(1);
    expect(usage.outputTokens).toBe(3);
  });
});
