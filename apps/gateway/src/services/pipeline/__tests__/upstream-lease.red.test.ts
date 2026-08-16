import { describe, expect, it } from 'vitest';
import { upstreamLeaseMs } from '../types.js';

/**
 * 审计 P0-5（租约侧）：非流式调用没有任何租约续期（续期只存在于流式的
 * withBillingLifecycle）。租约若只取 BILLING_LEASE_SECONDS（默认 60s），
 * 长耗时非流式请求（预算可到 240s）会在仍在途时被 worker recoverOnce
 * 转 uncertain，进而被小额通道自动放行 → 用户拿到 503、平台漏收。
 *
 * 不变量：上游租约必须覆盖请求的权威时间上界（budget deadline），
 * 使「租约过期」只可能发生在网关侧已终止/崩溃的请求上。
 */
describe('upstreamLeaseMs — 租约覆盖请求 deadline', () => {
  it('deadline 超过租约时，租约 = deadline + 余量', () => {
    expect(upstreamLeaseMs(60_000, 120_000)).toBeGreaterThanOrEqual(130_000);
    expect(upstreamLeaseMs(60_000, 240_000)).toBeGreaterThanOrEqual(250_000);
  });

  it('deadline 较短时保持租约下限（流式续期节奏不变）', () => {
    expect(upstreamLeaseMs(60_000, 30_000)).toBe(60_000);
  });
});
