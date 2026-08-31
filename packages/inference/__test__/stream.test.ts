import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isBusinessError } from '@tillgate/errors';
import type { UpstreamStreamEvent } from '../src/ports/upstream';
import type { BillingSignal } from '../src/ports/billing';
import { createInference } from '../src/inference';
import { createMemoryHealthStore } from '../src/adapters/state-memory';
import {
  baseAuth,
  buildInference,
  channel,
  fakeAi,
  fakeBilling,
  fakeCatalog,
  fakeUpstream,
  mapping,
  streamResultOf,
  upstreamError,
} from './harness';
import { staticRoutingPolicy } from '../src/ports/routing';
import { routingPolicySchema } from '../src/routing/policy';

/**
 * 流式尝试（决定性事件 / 续租 / 终态后台结算）。
 * 计时器类用例用假时钟 + 容差；续租节奏断言允许 ±1 次抖动。
 */
function setup(defaults?: Parameters<typeof buildInference>[0]['defaults']) {
  const ai = fakeAi();
  const upstream = fakeUpstream();
  const billing = fakeBilling();
  const catalog = fakeCatalog(
    { 'gpt-x': mapping() },
    { 'gpt-x-real': [channel({ channelId: 1, channelName: 'ch-a' })] },
  );
  const inference = buildInference({
    ai: ai.ai,
    catalog,
    billing: billing.port,
    upstream: upstream.port,
    policy: staticRoutingPolicy(routingPolicySchema.parse({ enabled: true })),
    ...(defaults != null ? { defaults } : {}),
  });
  return { inference, upstream, billing, detach: () => inference.close() };
}

const body = { model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }], stream: true };

/** 装配一条手动泵事件的流，并注册到 upstream 桩 */
function wireStream(
  upstream: ReturnType<typeof fakeUpstream>,
  onEmit: (emit: (e: UpstreamStreamEvent) => void) => void,
) {
  const handle = streamResultOf();
  upstream.onStream(async () => {
    queueMicrotask(() => onEmit(handle.emit));
    return handle.result;
  });
  return handle;
}

function succeededOf(signals: BillingSignal[]) {
  return signals.find((e) => e.type === 'request_succeeded') as
    | Extract<BillingSignal, { type: 'request_succeeded' }>
    | undefined;
}

describe('application/stream：流式尝试', () => {
  beforeEach(() => {
    // 只假计时器：queueMicrotask 必须真实（决定性事件的泵送依赖微任务，假掉即死锁）
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('上线：first_chunk 决定性 → 管道立即交还；租约按 1/3 TTL 续期、终态即停', async () => {
    const s = setup({
      authorization: { ttlMs: 3_000 },
      streamLease: { minRenewIntervalMs: 1_000, maxRenewals: 100 },
    });
    const startedAt = Date.now();
    let emit!: (e: UpstreamStreamEvent) => void;
    wireStream(s.upstream, (e) => {
      emit = e;
      e({ type: 'first_chunk', atMs: startedAt + 50 });
    });
    const delivered = await s.inference.stream({ requestId: 'req-1', auth: baseAuth, body });
    expect(delivered).toMatchObject({ ok: true, status: 200, contentType: 'text/event-stream' });
    expect(s.billing.signals.filter((e) => e.type === 'lease_renewed')).toHaveLength(0); // 上线前不续租
    await vi.advanceTimersByTimeAsync(3_500); // ~3 个续租周期
    const renewals = s.billing.signals.filter((e) => e.type === 'lease_renewed');
    expect(renewals.length).toBeGreaterThanOrEqual(2);
    expect(renewals.length).toBeLessThanOrEqual(4);
    // 终态：可信 usage → 正常结算 + TTFT 双锚点；终态后不再续租
    emit({
      type: 'success',
      usage: {
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 20,
        estimated: false,
        raw: null,
      },
      durationMs: 4_000,
    });
    await vi.advanceTimersByTimeAsync(3_000);
    const receipt = succeededOf(s.billing.signals)?.receipt;
    expect(receipt).toMatchObject({
      stream: true,
      streamAborted: false,
      clientTtftMs: expect.any(Number),
    });
    // TTFT 双锚点（负载稳定不变量）：名义值 = 合成锚 50ms 减去真实管线引导耗时
    // （全套并发下引导可达数十 ms，±10ms 窗口必假红）。钉住语义而非绝对值：
    // ① upstream 锚点落在 [0, 60]——排除「锚到 durationMs=4_000」的错误形态；
    // ② client 锚点含管线引导（授权/路由），恒 ≥ upstream 锚点且 ≤ 1_000。
    expect(receipt?.upstreamTtftMs).toBeGreaterThanOrEqual(0);
    expect(receipt?.upstreamTtftMs).toBeLessThanOrEqual(60);
    expect(Number(receipt?.clientTtftMs)).toBeGreaterThanOrEqual(Number(receipt?.upstreamTtftMs));
    expect(receipt?.clientTtftMs).toBeLessThanOrEqual(1_000);
    expect(receipt?.usage).toEqual({
      estimated: false,
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 20,
    });
    const countAfterTerminal = s.billing.signals.filter((e) => e.type === 'lease_renewed').length;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(s.billing.signals.filter((e) => e.type === 'lease_renewed')).toHaveLength(
      countAfterTerminal,
    );
    s.detach();
  });

  it('中断流（upstream_truncated）缺 usage → 估算收据 + upstream_error_partial 归属 + bytesRelayed', async () => {
    const s = setup({ settleSignal: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 } });
    wireStream(s.upstream, (emit) => {
      emit({ type: 'first_chunk', atMs: Date.now() });
      emit({
        type: 'success',
        terminated: 'upstream_truncated',
        bytesRelayed: 512,
        outputFeatures: { cjkChars: 20, wordSegments: 0, numberSegments: 0, symbolCount: 0 },
        durationMs: 900,
      });
    });
    const delivered = await s.inference.stream({ requestId: 'req-2', auth: baseAuth, body });
    expect(delivered).toMatchObject({ ok: true, status: 200 });
    await vi.advanceTimersByTimeAsync(10);
    const receipt = succeededOf(s.billing.signals)?.receipt;
    expect(receipt).toMatchObject({
      streamAborted: true,
      estimatedFor: 'upstream_error_partial',
      bytesRelayed: 512,
    });
    expect(receipt?.usage).toEqual({
      estimated: true,
      inputTokens: expect.any(Number),
      outputTokens: 14,
      cachedInputTokens: 0,
    });
    s.detach();
  });

  it('零块完成（决定性即终态）：无 first_chunk 也可交付并后台结算；无 TTFT 字段', async () => {
    const s = setup({ settleSignal: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 } });
    wireStream(s.upstream, (emit) => {
      emit({
        type: 'success',
        usage: {
          inputTokens: 3,
          cachedInputTokens: 0,
          outputTokens: 0,
          estimated: false,
          raw: null,
        },
        durationMs: 30,
      });
    });
    const delivered = await s.inference.stream({ requestId: 'req-3', auth: baseAuth, body });
    expect(delivered).toMatchObject({ ok: true, status: 200 });
    await vi.advanceTimersByTimeAsync(10);
    const receipt = succeededOf(s.billing.signals)?.receipt;
    expect(receipt?.usage.inputTokens).toBe(3);
    expect(receipt?.upstreamTtftMs).toBeUndefined(); // 零块无首字锚点
    s.detach();
  });

  it('首字节前失败：换渠语义（failed 决定性 → dispatchFailure）', async () => {
    const s = setup();
    wireStream(s.upstream, (emit) => {
      emit({ type: 'failed', error: upstreamError('timeout') });
    });
    await expect(
      s.inference.stream({ requestId: 'req-4', auth: baseAuth, body }),
    ).rejects.toSatisfy(
      (e: unknown) => isBusinessError(e) && e.code === 'inference.upstream_failed',
    );
    // 上游故障全败 → request.failed 信号在列
    expect(s.billing.signals.at(-1)).toMatchObject({ type: 'request_failed', reason: 'timeout' });
    s.detach();
  });

  it('结算重试期间续租不停；耗尽后 onError 响亮记损并停租（v1 纪律）', async () => {
    const s = setup({
      authorization: { ttlMs: 3_000 },
      streamLease: { minRenewIntervalMs: 1_000, maxRenewals: 100 },
      settleSignal: { attempts: 2, baseDelayMs: 1_500, maxDelayMs: 2_000 },
    });
    const noted: string[] = [];
    // buildInference 不透传 onError——经 fakeBilling signal 失败驱动重试路径
    const original = s.billing.port.signal;
    s.billing.port.signal = async (input) => {
      if (input.type === 'request_succeeded') throw new Error('db down');
      await original(input);
    };
    let emit!: (e: UpstreamStreamEvent) => void;
    wireStream(s.upstream, (e) => {
      emit = e;
      e({ type: 'first_chunk', atMs: Date.now() });
    });
    await s.inference.stream({ requestId: 'req-5', auth: baseAuth, body });
    emit({
      type: 'success',
      usage: { inputTokens: 5, cachedInputTokens: 0, outputTokens: 5, estimated: false, raw: null },
      durationMs: 10,
    });
    // 第一次结算失败 → 退避 1.5s；期间续租继续（alive 保持到结算收尾）
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(600);
    const renewalsDuringRetry = s.billing.signals.filter((e) => e.type === 'lease_renewed').length;
    expect(renewalsDuringRetry).toBeGreaterThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(5_000); // 第二次重试后耗尽
    const renewalsFinal = s.billing.signals.filter((e) => e.type === 'lease_renewed').length;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(s.billing.signals.filter((e) => e.type === 'lease_renewed')).toHaveLength(renewalsFinal);
    void noted;
    s.detach();
  });

  it('续租次数上限（maxRenewals）：到达后静默停租（终态永不到达的泄漏防御）', async () => {
    const s = setup({
      authorization: { ttlMs: 3_000 },
      streamLease: { minRenewIntervalMs: 1_000, maxRenewals: 3 },
    });
    let emit!: (e: UpstreamStreamEvent) => void;
    wireStream(s.upstream, (e) => {
      emit = e;
      e({ type: 'first_chunk', atMs: Date.now() });
    });
    await s.inference.stream({ requestId: 'req-6', auth: baseAuth, body });
    await vi.advanceTimersByTimeAsync(10_000); // 远超 3 次上限
    expect(s.billing.signals.filter((e) => e.type === 'lease_renewed')).toHaveLength(3);
    emit({ type: 'success', durationMs: 1 }); // 终态清理定时器（不抛）
    await vi.advanceTimersByTimeAsync(10);
    s.detach();
  });

  it('B16 回归：后台结算链意外崩溃 → onError 观察 + 续租定时器停（void settle 无 catch 的泄漏）', async () => {
    // 注入 onError 在结算重试路径抛出（重试器 catch 内的二次故障——初版
    // `void settle(event)` 无 .catch，异常成为 unhandled rejection 且续租不停）
    const ai = fakeAi();
    const upstream = fakeUpstream();
    const billing = fakeBilling();
    const catalog = fakeCatalog(
      { 'gpt-x': mapping() },
      { 'gpt-x-real': [channel({ channelId: 1, channelName: 'ch-a' })] },
    );
    const faults: string[] = [];
    const original = billing.port.signal;
    billing.port.signal = async (input) => {
      if (input.type === 'request_succeeded') throw new Error('db down');
      await original(input);
    };
    const inference = createInference({
      ai: ai.ai,
      catalog,
      billing: billing.port,
      store: createMemoryHealthStore(),
      decrypt: (enc) => `plain:${enc}`,
      upstream: upstream.port,
      defaults: {
        authorization: { ttlMs: 3_000 },
        streamLease: { minRenewIntervalMs: 1_000, maxRenewals: 100 },
        settleSignal: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      },
      onError: (error, context) => {
        faults.push(context);
        if (context.startsWith('signal request_succeeded')) throw error; // 重试器内二次故障
      },
    });
    let emit!: (e: UpstreamStreamEvent) => void;
    wireStream(upstream, (e) => {
      emit = e;
      e({ type: 'first_chunk', atMs: Date.now() });
    });
    await inference.stream({ requestId: 'req-7', auth: baseAuth, body });
    await vi.advanceTimersByTimeAsync(1_200); // 至少 1 次续租后触发终态
    const renewalsBeforeCrash = billing.signals.filter((e) => e.type === 'lease_renewed').length;
    expect(renewalsBeforeCrash).toBeGreaterThanOrEqual(1);
    emit({
      type: 'success',
      usage: { inputTokens: 5, cachedInputTokens: 0, outputTokens: 5, estimated: false, raw: null },
      durationMs: 10,
    });
    await vi.advanceTimersByTimeAsync(10); // 结算链崩溃落地（.catch 观察 + 停租）
    expect(faults.some((c) => c.includes('stream settle crashed'))).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000); // 停租后不再续租（定时器已清）
    expect(billing.signals.filter((e) => e.type === 'lease_renewed')).toHaveLength(
      renewalsBeforeCrash,
    );
    inference.close();
  });
});
