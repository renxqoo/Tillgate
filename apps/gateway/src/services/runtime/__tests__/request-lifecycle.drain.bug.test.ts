import { describe, expect, it } from 'vitest';
import { createRequestLifecycle } from '../request-lifecycle.js';

/**
 * H2 语义回归：drain 只拒绝新请求，不得中止在途请求。
 *
 * 缺陷（审计 P0-1）：beginDrain() 在 SIGTERM 的 t=0 即 abort 全部在途请求的
 * budget signal → 在途 SSE 流被注入错误帧并按 request_cancelled（用户侧取消）
 * 估算计费——网关自己的发布行为被计费为用户责任。
 *
 * 正确语义：
 *   1. beginDrain 后，此前创建的 budget 不受影响（在途请求跑到自然结束/deadline）；
 *   2. beginDrain 后，新请求在 create() 即被拒绝（ServiceDrainingError → 503）；
 *   3. 宽限期结束后才 abort 在途 budget，且 abort reason 是 ServerDrainAbort
 *      标记（供计费侧归类为服务端原因，而非用户取消）。
 */
describe('RequestLifecycle — drain 语义', () => {
  it('在途 budget 在 beginDrain 后不被 abort', () => {
    const lc = createRequestLifecycle(60_000);
    const budget = lc.create(new AbortController().signal);
    lc.beginDrain(1_000);
    expect(budget.signal.aborted).toBe(false);
  });

  it('beginDrain 后新请求被拒绝', () => {
    const lc = createRequestLifecycle(60_000);
    lc.beginDrain(1_000);
    expect(() => lc.create(new AbortController().signal)).toThrow();
  });

  it('drain 前创建的 budget 在宽限期后被 abort，且 reason 携带服务端标记', async () => {
    const lc = createRequestLifecycle(60_000);
    const budget = lc.create(new AbortController().signal);
    lc.beginDrain(20);
    await new Promise((r) => setTimeout(r, 60));
    expect(budget.signal.aborted).toBe(true);
    const marker = (budget.signal as AbortSignal & { reason?: unknown }).reason;
    expect(
      marker instanceof Error && (marker as Error & { serverDraining?: boolean }).serverDraining,
    ).toBe(true);
  });
});
