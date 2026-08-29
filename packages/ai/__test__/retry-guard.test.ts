import { describe, expect, it } from 'vitest';
import { withRetry, backoffDelayMs } from '../src/retry/with-retry.js';
import { UpstreamError } from '../src/errors/kinds.js';
import { assertSafeUrlSync, allowAllUrls, fetchUpstream } from '../src/transport/http-client.js';

const opts = {
  maxAttempts: 3,
  baseDelayMs: 1,
  maxDelayMs: 4,
  jitterRatio: 0,
  deadlineMs: 1000,
  emptyCompletionRetries: 1,
};
const err = (kind: 'rate_limited' | 'invalid_request' | 'upstream_error') =>
  new UpstreamError({ kind });

describe('retry/with-retry：重试语义与边界', () => {
  it('可重试错误重试到 maxAttempts；onRetry 回调收到延迟', async () => {
    let n = 0;
    const retries: number[] = [];
    const { outcome, attempts } = await withRetry(
      async () => {
        n += 1;
        return n < 3
          ? { ok: false as const, error: err('rate_limited') }
          : { ok: true as const, value: n };
      },
      opts,
      (i) => retries.push(i.delayMs),
    );
    expect(outcome.ok).toBe(true);
    expect(attempts).toBe(3);
    expect(retries.length).toBe(2);
  });
  it('不可重试立即停止（invalid_request）', async () => {
    let n = 0;
    const { attempts } = await withRetry(async () => {
      n += 1;
      return { ok: false as const, error: err('invalid_request') };
    }, opts);
    expect(attempts).toBe(1);
    expect(n).toBe(1);
  });
  it('空完成独立预算：empty 重试 emptyCompletionRetries 次后停', async () => {
    let n = 0;
    const { outcome, attempts } = await withRetry(async () => {
      n += 1;
      return { ok: false as const, error: err('upstream_error'), empty: true };
    }, opts);
    expect(outcome.ok).toBe(false);
    // 空完成不占 retryable 预算但受 maxAttempts 限制
    expect(attempts).toBeLessThanOrEqual(opts.maxAttempts);
    expect(n).toBe(attempts);
  });
  it('deadline 取消：signal abort 后停止重试', async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5);
    let n = 0;
    const { attempts } = await withRetry(
      async () => {
        n += 1;
        return { ok: false as const, error: err('rate_limited') };
      },
      { ...opts, baseDelayMs: 30, maxDelayMs: 30, signal: ctrl.signal },
    );
    expect(attempts).toBeLessThan(opts.maxAttempts);
  });
  it('rate_limited 的 retryAfterMs 是退避下界（低于指数退避时抬高到 Retry-After）', async () => {
    let n = 0;
    const delays: number[] = [];
    const rateLimited = new UpstreamError({ kind: 'rate_limited', retryAfterMs: 25 });
    const { attempts } = await withRetry(
      async () => {
        n += 1;
        return { ok: false as const, error: rateLimited };
      },
      opts,
      (i) => delays.push(i.delayMs),
    );
    expect(attempts).toBe(opts.maxAttempts);
    // opts.baseDelayMs=1/maxDelayMs=4 → 指数退避 1,2；retryAfterMs=25 抬高下界
    expect(delays).toEqual([25, 25]);
  });
  it('retryAfterMs 低于指数退避时不影响（取较大者）', async () => {
    let n = 0;
    const delays: number[] = [];
    const rateLimited = new UpstreamError({ kind: 'rate_limited', retryAfterMs: 1 });
    await withRetry(
      async () => {
        n += 1;
        return { ok: false as const, error: rateLimited };
      },
      opts,
      (i) => delays.push(i.delayMs),
    );
    expect(delays).toEqual([1, 2]);
  });
  it('有效等待超过剩余 deadline：立即放弃同渠道重试（不睡到 deadline 打断）', async () => {
    // retryAfterMsOf 解析上限 3600s——病态上游的权威下界不得吞掉整段同渠道预算
    const rateLimited = new UpstreamError({ kind: 'rate_limited', retryAfterMs: 3_600_000 });
    const retries: number[] = [];
    const startedAt = Date.now();
    const { outcome, attempts } = await withRetry(
      async () => ({ ok: false as const, error: rateLimited }),
      { ...opts, deadlineMs: 2_000 },
      (i) => retries.push(i.delayMs),
    );
    expect(outcome).toEqual({ ok: false, error: rateLimited }); // 最后错误原样交回编排层
    expect(attempts).toBe(1); // 未再消耗同渠道重试预算
    expect(retries).toEqual([]); // 未真正重试 → 不发 onRetry
    // 旧实现睡到 2s deadline 被打断才返回；判定后应立即返回
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
  it('剩余预算随耗时收紧：首次等待放行，第二次超剩余即放弃（判定用剩余而非全量）', async () => {
    const rateLimited = new UpstreamError({ kind: 'rate_limited', retryAfterMs: 300 });
    const delays: number[] = [];
    const { attempts } = await withRetry(
      async () => ({ ok: false as const, error: rateLimited }),
      { ...opts, deadlineMs: 500 },
      (i) => delays.push(i.delayMs),
    );
    // 首次失败剩余 ≈500ms > 300 → 睡后重试；第二次失败剩余 ≈200ms < 300 → 立即放弃
    expect(attempts).toBe(2);
    expect(delays).toEqual([300]);
  });
  it('backoffDelayMs：指数 + 封顶 + jitter=0 确定性', () => {
    expect(backoffDelayMs(1, 10, 100, 0)).toBe(10);
    expect(backoffDelayMs(2, 10, 100, 0)).toBe(20);
    expect(backoffDelayMs(9, 10, 100, 0)).toBe(100);
    const j = backoffDelayMs(1, 10, 100, 0.5);
    expect(j).toBeGreaterThanOrEqual(1);
    expect(j).toBeLessThanOrEqual(15);
  });
});

describe('transport/http-client：SSRF 守卫矩阵（机制/策略分离）', () => {
  it('默认机械基线：https-only、禁 localhost、禁私网/回环字面量', () => {
    expect(() => assertSafeUrlSync('http://example.com')).toThrow(/unsupported protocol/);
    expect(() => assertSafeUrlSync('https://localhost/x')).toThrow(/blocked host/);
    expect(() => assertSafeUrlSync('https://127.0.0.1/x')).toThrow(/blocked address/);
    expect(() => assertSafeUrlSync('https://10.0.0.1/x')).toThrow(/blocked address/);
    expect(() => assertSafeUrlSync('https://169.254.169.254/x')).toThrow(/blocked address/);
    expect(() => assertSafeUrlSync('https://[::1]/x')).toThrow(/blocked address/);
    expect(() => assertSafeUrlSync('https://[::ffff:127.0.0.1]/x')).toThrow(/blocked address/);
    expect(() => assertSafeUrlSync('not a url')).toThrow(/invalid upstream url/);
    expect(assertSafeUrlSync('https://api.openai.com/v1').hostname).toBe('api.openai.com');
  });
  it('allowLocal 豁免：http 与内网放行（测试策略注入）', () => {
    expect(assertSafeUrlSync('http://127.0.0.1:3000/x', { allowLocal: true }).hostname).toBe(
      '127.0.0.1',
    );
  });
  it('fetchUpstream guard 注入：allowAllUrls 放行本地；缺省基线拒绝本地', async () => {
    // 缺省基线拒绝（不真正建连）
    await expect(
      fetchUpstream('http://127.0.0.1:1/x', { method: 'GET' }, { connectMs: 500 }),
    ).rejects.toThrow(/protocol|blocked/);
    // guard 整体替换后由连接层报错（端口不可达）
    await expect(
      fetchUpstream(
        'http://127.0.0.1:1/x',
        { method: 'GET' },
        { connectMs: 300, guard: allowAllUrls },
      ),
    ).rejects.toThrow();
  });
  it('派发前取消：aborted signal 不发请求', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      fetchUpstream('https://x.test/', { method: 'GET' }, { connectMs: 100, signal: ctrl.signal }),
    ).rejects.toThrow(/aborted before dispatch/);
  });
});
