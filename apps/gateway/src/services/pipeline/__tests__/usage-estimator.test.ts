import { describe, expect, it } from 'vitest';
import { estimateCancelledUsage, USER_SIDE_CANCELS } from '../usage-estimator.js';

/**
 * 取消估算器（权威公式单一真相）：
 *   output = bytesRelayed × tokensPerByte，tokensPerByte 来自固定校准配置（按 provider/model 覆盖）
 *   input  = estimateInputTokens(body)（与预扣同源，CJK 感知），一律全价（cached=0，new-api 口径防套利）
 *   硬夹：estOutput ≤ maxOutputTokens（input 已与预扣同源，无需二次上界夹）
 * 责任域：仅 USER_SIDE_CANCELS（用户侧取消）允许估算结算。
 */
describe('estimateCancelledUsage', () => {
  it('MiniMax-M3：按校准配置的 tokensPerByte（0.03）换算 output，input 一律全价（cached=0）', () => {
    const usage = estimateCancelledUsage({
      model: 'MiniMax-M3',
      providerName: 'minimax',
      inputTokens: 2000,
      bytesRelayed: 3370, // × 0.03 = 101 token
      maxOutputTokens: 32768,
    });
    expect(usage.estimated).toBe(true);
    expect(usage.outputTokens).toBe(101);
    expect(usage.inputTokens).toBe(2000);
    expect(usage.cachedInputTokens).toBe(0); // new-api 口径：不给缓存折扣，杜绝「破缓存+取消」套利
  });

  it('未知模型回退全局 tokensPerByte（0.12）', () => {
    const usage = estimateCancelledUsage({
      model: 'some-unknown-model',
      providerName: 'unknown',
      inputTokens: 100,
      bytesRelayed: 1000, // × 0.12 = 120
      maxOutputTokens: 32768,
    });
    expect(usage.outputTokens).toBe(120);
  });

  it('硬夹：output ≤ maxOutputTokens', () => {
    const usage = estimateCancelledUsage({
      model: 'MiniMax-M3',
      providerName: 'minimax',
      inputTokens: 2000,
      bytesRelayed: 10_000_000,
      maxOutputTokens: 100,
    });
    expect(usage.outputTokens).toBeLessThanOrEqual(100);
    expect(usage.inputTokens).toBe(2000);
  });

  it('TTFB 期取消（bytesRelayed=0）→ output=0，仅 input', () => {
    const usage = estimateCancelledUsage({
      model: 'MiniMax-M3',
      providerName: 'minimax',
      inputTokens: 2000,
      bytesRelayed: 0,
      maxOutputTokens: 32768,
    });
    expect(usage.outputTokens).toBe(0);
    expect(usage.inputTokens).toBe(2000);
  });

  it('责任域常量：仅用户侧取消可估算', () => {
    expect(USER_SIDE_CANCELS).toEqual(['client_disconnect', 'request_cancelled', 'aborted']);
  });
});
