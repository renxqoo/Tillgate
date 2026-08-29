import { describe, expect, it } from 'vitest';
import { createChannelHealth, channelHealthKey } from '../src/health/channel-health';
import { createMemoryHealthStore } from '../src/adapters/state-memory';
import { fakeAi, upstreamError } from './harness';
import type { BreakerState } from '../src/health/breaker';
import type { DeadCredentialState } from '../src/health/dead-credential';

const config = {
  breaker: { windowMs: 60_000, failureThreshold: 2, cooldownMs: 300_000, halfOpenProbe: true },
  deadCredential: { failureThreshold: 2, windowMs: 3_600_000 },
};

/** 等待 fire-and-forget 状态机更新落地 */
const flush = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 5);
  });

describe('health/channel-health：熔断订阅面 + 死凭据显式记账面（channel 维）', () => {
  it('健康键 = protocol://host（与 ai 事件 channelKey 同算法）；坏 baseUrl 兜底 unknown', () => {
    expect(channelHealthKey({ protocol: 'openai-compatible', baseUrl: 'https://a.com/v1' })).toBe(
      'openai-compatible://a.com',
    );
    expect(channelHealthKey({ protocol: 'anthropic', baseUrl: '::::' })).toBe(
      'anthropic://unknown',
    );
  });

  it('B11 回归（v2 实施期缺陷）：熔断键与死凭据键互不踩踏（机器级键前缀隔离）', async () => {
    const store = createMemoryHealthStore();
    const health = createChannelHealth({ store, config });
    const { ai, emit } = fakeAi();
    health.attach(ai);
    // 熔断失败走事件面（host 键）；死凭据失败走显式记账（channel 键）
    emit({ type: 'failed', requestId: 'r1', channelKey: 'kb', error: upstreamError('network') });
    health.recordDeadCredential(7, true);
    await flush();
    const breaker = await store.getState<BreakerState>('breaker:kb');
    const credential = await store.getState<DeadCredentialState>('credential:ch:7');
    expect(breaker?.failures).toHaveLength(1);
    expect(breaker).not.toHaveProperty('consecutiveFailures'); // 未被凭据形状覆盖
    expect(credential?.consecutiveFailures).toBe(1);
    expect(credential).not.toHaveProperty('failures');
  });

  it('事件面 failed 只计熔断：deadCredential 信号不在事件面记账（无渠道粒度）', async () => {
    const store = createMemoryHealthStore();
    const health = createChannelHealth({ store, config });
    const { ai, emit } = fakeAi();
    health.attach(ai);
    emit({
      type: 'failed',
      requestId: 'r',
      channelKey: 'k1',
      error: upstreamError('invalid_api_key'),
    });
    await flush();
    const breaker = await store.getState<BreakerState>('breaker:k1');
    expect(breaker).toBeNull(); // invalid_api_key circuitTrip=false 不计熔断
    // 事件面无 channelId——死凭据键无写入（记账归 dispatchFailure 收口面）
    expect(await store.getState<DeadCredentialState>('credential:ch:1')).toBeNull();
  });

  it('failed 事件：网络错误只计熔断（不判死凭据）', async () => {
    const store = createMemoryHealthStore();
    const health = createChannelHealth({ store, config });
    const { ai, emit } = fakeAi();
    health.attach(ai);
    emit({ type: 'failed', requestId: 'r', channelKey: 'k1', error: upstreamError('network') });
    await flush();
    expect((await store.getState<BreakerState>('breaker:k1'))?.failures).toHaveLength(1);
    expect(await store.getState<DeadCredentialState>('credential:ch:1')).toBeNull();
  });

  it('熔断达阈值 → admit 拒 circuit_open（host 键）；死凭据显式记账达阈值 → 拒 dead_credential（channel 键）', async () => {
    const store = createMemoryHealthStore();
    const health = createChannelHealth({ store, config });
    const { ai, emit } = fakeAi();
    health.attach(ai);
    emit({ type: 'failed', requestId: 'r1', channelKey: 'kb', error: upstreamError('network') });
    emit({ type: 'failed', requestId: 'r2', channelKey: 'kb', error: upstreamError('timeout') });
    health.recordDeadCredential(3, true);
    health.recordDeadCredential(3, true);
    await flush();
    expect(await health.admit('kb', 1)).toEqual({ ok: false, reason: 'circuit_open' });
    expect(await health.admit('other', 1)).toEqual({ ok: true }); // 熔断是 host 维
    // 死凭据查询用未熔断 host（admit 先查熔断——open 短路后续检查）
    expect(await health.admit('kh', 3)).toEqual({ ok: false, reason: 'dead_credential' });
    expect(await health.admit('kh', 4)).toEqual({ ok: true }); // 死凭据是 channel 维
    expect(await health.admit('unknown-key', 9)).toEqual({ ok: true });
  });

  it('死凭据成功自愈走显式动词（recordChannelSuccess）；first_chunk 只记熔断', async () => {
    const store = createMemoryHealthStore();
    const health = createChannelHealth({ store, config });
    const { ai, emit } = fakeAi();
    health.attach(ai);
    health.recordDeadCredential(5, true);
    health.recordDeadCredential(5, true);
    await flush();
    expect(await health.admit('kh', 5)).toEqual({ ok: false, reason: 'dead_credential' });
    // first_chunk（事件面）不影响死凭据（无渠道粒度）
    emit({ type: 'attempt_start', requestId: 'r3', channelKey: 'kh', attempt: 1, atMs: 1 });
    emit({ type: 'first_chunk', requestId: 'r3', atMs: 2 });
    await flush();
    expect(await health.admit('kh', 5)).toEqual({ ok: false, reason: 'dead_credential' });
    // 结算成功自愈（候选循环 settle 收口调用）
    health.recordChannelSuccess(5);
    await flush();
    expect(await health.admit('kh', 5)).toEqual({ ok: true });
  });

  it('终态 success：故障族 terminated 计熔断失败；正常/用户侧/停机记成功', async () => {
    const store = createMemoryHealthStore();
    const health = createChannelHealth({ store, config });
    const { ai, emit } = fakeAi();
    health.attach(ai);
    // 正常完成 → 记成功（closed 态 no-op）
    emit({ type: 'success', requestId: 'r1', channelKey: 'ks', durationMs: 10 });
    // 故障截断 ×2 → 熔断 open
    emit({
      type: 'success',
      requestId: 'r2',
      channelKey: 'ks',
      durationMs: 10,
      terminated: 'upstream_truncated',
    });
    emit({
      type: 'success',
      requestId: 'r3',
      channelKey: 'ks',
      durationMs: 10,
      terminated: 'inactivity',
    });
    await flush();
    expect(await health.admit('ks', 1)).toEqual({ ok: false, reason: 'circuit_open' });
    // 用户取消/停机不进熔断状态机（client_disconnect/server_draining 非渠道问题）
    emit({ type: 'aborted', requestId: 'r4', reason: 'client_disconnect' });
    expect(await health.admit('other', 1)).toEqual({ ok: true });
  });

  it('empty_completion / param_adjustment 等不进状态机；failed/success 后清理 requestId 映射', async () => {
    const store = createMemoryHealthStore();
    const health = createChannelHealth({ store, config });
    const { ai, emit } = fakeAi();
    const detach = health.attach(ai);
    emit({ type: 'empty_completion', requestId: 'r', channelKey: 'ke', attempt: 1 });
    emit({ type: 'param_adjustment', requestId: 'r', param: 'x', action: 'ignore' });
    emit({ type: 'stream_error', requestId: 'r', frame: { code: 'x' } });
    await flush();
    expect(await store.getState<BreakerState>('breaker:ke')).toBeNull();
    detach();
  });

  it('B12 回归（v2 实施期缺陷）：empty_completion 终态清理 requestId→channelKey 映射（currentChannel 泄漏）', async () => {
    // 泄漏形态：ai 非流式空完成重试耗尽只发 empty_completion（无 failed/success 跟随），
    // 只在这两个终态清 currentChannel 的话映射随请求量无界增长；且同 requestId 迟到的
    // first_chunk 会借残留映射把成功记到已终态的渠道上（误恢复熔断窗口）。
    const store = createMemoryHealthStore();
    const health = createChannelHealth({ store, config });
    const { ai, emit } = fakeAi();
    health.attach(ai);
    // 熔断计数 1 次（未达阈值 2）
    emit({ type: 'failed', requestId: 'r0', channelKey: 'kc', error: upstreamError('network') });
    // 空完成终态序列：attempt_start 登记 → empty_completion 终态（映射应被清理）
    emit({ type: 'attempt_start', requestId: 'rx', channelKey: 'kc', attempt: 1, atMs: 1 });
    emit({ type: 'empty_completion', requestId: 'rx', channelKey: 'kc', attempt: 1 });
    // 同 requestId 迟到的 first_chunk：映射已清 → 不记账（泄漏形态会误记成功清窗）
    emit({ type: 'first_chunk', requestId: 'rx', atMs: 2 });
    await flush();
    const breaker = await store.getState<BreakerState>('breaker:kc');
    expect(breaker?.failures).toHaveLength(1); // 迟到 first_chunk 未清窗
  });

  it('P2 回归网：三类终态（success/failed/empty_completion）都清映射——迟到 first_chunk 不误恢复 half-open 探测', async () => {
    // half-open 是唯一能观察「误记成功」的状态：closed 态 recordSuccess 为 no-op，
    // 断言不出映射泄漏。此处把渠道打到 half-open，若终态未清映射，迟到的
    // first_chunk 会借残留映射 recordSuccess → half-open 恢复 closed（探测窗口被清）。
    // （channel-health 状态机用真实时钟——冷却 1ms 让 open 即刻可转 half-open）
    const shortCooldown = {
      ...config,
      breaker: { ...config.breaker, cooldownMs: 1 },
    };
    const store = createMemoryHealthStore();
    const health = createChannelHealth({ store, config: shortCooldown });
    const { ai, emit } = fakeAi();
    health.attach(ai);
    const toHalfOpen = async (key: string): Promise<void> => {
      emit({
        type: 'failed',
        requestId: `${key}-f1`,
        channelKey: key,
        error: upstreamError('network'),
      });
      emit({
        type: 'failed',
        requestId: `${key}-f2`,
        channelKey: key,
        error: upstreamError('timeout'),
      });
      await flush(); // 冷却 1ms 已过 → admit 触发 open→half-open
      expect(await health.admit(key, 1)).toEqual({ ok: true });
    };
    // ra：failed 终态（invalid_api_key circuitTrip=false——熔断面无变化，渠道保持 half-open）
    await toHalfOpen('ka');
    emit({ type: 'attempt_start', requestId: 'ra', channelKey: 'ka', attempt: 1, atMs: 1 });
    emit({
      type: 'failed',
      requestId: 'ra',
      channelKey: 'ka',
      error: upstreamError('invalid_api_key'),
    });
    // rb：success 终态换渠（记账落 kb2 键；kb 本身保持 half-open）
    await toHalfOpen('kb');
    emit({ type: 'attempt_start', requestId: 'rb', channelKey: 'kb', attempt: 1, atMs: 1 });
    emit({ type: 'success', requestId: 'rb', channelKey: 'kb2', durationMs: 5 });
    // rc：empty_completion 终态（只清映射不记账）
    await toHalfOpen('kc');
    emit({ type: 'attempt_start', requestId: 'rc', channelKey: 'kc', attempt: 1, atMs: 1 });
    emit({ type: 'empty_completion', requestId: 'rc', channelKey: 'kc', attempt: 1 });
    await flush();
    // 同 requestId 迟到的 first_chunk：映射已被终态清理 → 不得记账（残留形态会把 half-open 误翻 closed）
    emit({ type: 'first_chunk', requestId: 'ra', atMs: 9 });
    emit({ type: 'first_chunk', requestId: 'rb', atMs: 9 });
    emit({ type: 'first_chunk', requestId: 'rc', atMs: 9 });
    await flush();
    for (const key of ['ka', 'kb', 'kc']) {
      expect(await store.getState<BreakerState>(`breaker:${key}`)).toMatchObject({
        state: 'half-open',
      });
    }
  });

  it('退订后不再消费事件（close 语义）', async () => {
    const store = createMemoryHealthStore();
    const health = createChannelHealth({ store, config });
    const { ai, emit } = fakeAi();
    const detach = health.attach(ai);
    detach();
    emit({ type: 'failed', requestId: 'r', channelKey: 'kz', error: upstreamError('network') });
    await flush();
    expect(await store.getState<BreakerState>('breaker:kz')).toBeNull();
  });

  it('状态机写失败不外溢（onFault 观察）；admit 存储故障 fail-open', async () => {
    const faults: string[] = [];
    const boom = {
      getState: async () => {
        throw new Error('redis down');
      },
      compareAndSet: async () => {
        throw new Error('redis down');
      },
    };
    const health = createChannelHealth({
      store: boom,
      config,
      onFault: (error, context) => faults.push(`${context}:${(error as Error).message}`),
    });
    const { ai, emit } = fakeAi();
    health.attach(ai);
    emit({ type: 'failed', requestId: 'r', channelKey: 'k', error: upstreamError('network') });
    await flush();
    expect(faults.length).toBeGreaterThan(0); // 写失败被观察而非吞没成静默
    expect(await health.admit('k', 1)).toEqual({ ok: true }); // fail-open：健康检查不作可用性单点
  });
});
