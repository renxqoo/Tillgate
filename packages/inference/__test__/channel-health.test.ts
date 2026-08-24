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

describe('health/channel-health：AiEvent 订阅者（§3.6 零运维状态的 inference 侧）', () => {
  it('健康键 = protocol://host（与 ai 事件 channelKey 同算法）；坏 baseUrl 兜底 unknown', () => {
    expect(channelHealthKey({ protocol: 'openai-compatible', baseUrl: 'https://a.com/v1' })).toBe(
      'openai-compatible://a.com',
    );
    expect(channelHealthKey({ protocol: 'anthropic', baseUrl: '::::' })).toBe(
      'anthropic://unknown',
    );
  });

  it('B11 回归（v2 实施期缺陷）：同渠道键下熔断与死凭据状态互不踩踏', async () => {
    // 初版两台状态机共用同一存储键，BreakerState/DeadCredentialState 两种 JSON 形状
    // 相互覆盖（v1 以双前缀规避的坑在重写中复现）——机器级键前缀是结构性修复。
    const store = createMemoryHealthStore();
    const health = createChannelHealth({ store, config });
    const { ai, emit } = fakeAi();
    health.attach(ai);
    // 同一渠道上：一次死凭据失败 + 一次熔断失败 → 两台状态各自独立记账
    emit({
      type: 'failed',
      requestId: 'r1',
      channelKey: 'kb',
      error: upstreamError('invalid_api_key'),
    });
    emit({ type: 'failed', requestId: 'r2', channelKey: 'kb', error: upstreamError('network') });
    await flush();
    const breaker = await store.getState<BreakerState>('breaker:kb');
    const credential = await store.getState<DeadCredentialState>('credential:kb');
    expect(breaker).toMatchObject({ state: 'closed', version: 1 }); // 只有 network 计入
    expect(breaker?.failures).toHaveLength(1);
    expect(breaker).not.toHaveProperty('consecutiveFailures'); // 未被凭据形状覆盖
    expect(credential).toMatchObject({ status: 'valid', version: 1 }); // 只有 401 计入
    expect(credential?.consecutiveFailures).toBe(1);
    expect(credential).not.toHaveProperty('failures');
  });

  it('failed 事件：circuitTrip 计熔断、deadCredential 计死凭据（机制位驱动）', async () => {
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
    const cred = await store.getState<DeadCredentialState>('credential:k1');
    expect(cred?.consecutiveFailures).toBe(1); // deadCredential=true 计数
    const breaker = await store.getState<BreakerState>('breaker:k1');
    expect(breaker).toBeNull(); // invalid_api_key circuitTrip=false 不计熔断
  });

  it('failed 事件：网络错误只计熔断（不判死凭据）', async () => {
    const store = createMemoryHealthStore();
    const health = createChannelHealth({ store, config });
    const { ai, emit } = fakeAi();
    health.attach(ai);
    emit({ type: 'failed', requestId: 'r', channelKey: 'k1', error: upstreamError('network') });
    await flush();
    expect((await store.getState<BreakerState>('breaker:k1'))?.failures).toHaveLength(1);
    expect(await store.getState<DeadCredentialState>('credential:k1')).toBeNull();
  });

  it('计数达阈值后 admit 拒绝（circuit_open / dead_credential 各自语义）', async () => {
    const store = createMemoryHealthStore();
    const health = createChannelHealth({ store, config });
    const { ai, emit } = fakeAi();
    health.attach(ai);
    emit({ type: 'failed', requestId: 'r1', channelKey: 'kb', error: upstreamError('network') });
    emit({ type: 'failed', requestId: 'r2', channelKey: 'kb', error: upstreamError('timeout') });
    emit({
      type: 'failed',
      requestId: 'r3',
      channelKey: 'kc',
      error: upstreamError('invalid_api_key'),
    });
    emit({
      type: 'failed',
      requestId: 'r4',
      channelKey: 'kc',
      error: upstreamError('invalid_api_key'),
    });
    await flush();
    expect(await health.admit('kb')).toEqual({ ok: false, reason: 'circuit_open' });
    expect(await health.admit('kc')).toEqual({ ok: false, reason: 'dead_credential' });
    expect(await health.admit('unknown-key')).toEqual({ ok: true });
  });

  it('first_chunk 记成功：经 attempt_start 的 requestId→channelKey 映射取键（首字节即成功，v1 语义）', async () => {
    const store = createMemoryHealthStore();
    const health = createChannelHealth({ store, config });
    const { ai, emit } = fakeAi();
    health.attach(ai);
    // 先 invalid 死凭据
    emit({
      type: 'failed',
      requestId: 'r',
      channelKey: 'kc',
      error: upstreamError('invalid_api_key'),
    });
    emit({
      type: 'failed',
      requestId: 'r2',
      channelKey: 'kc',
      error: upstreamError('invalid_api_key'),
    });
    await flush();
    expect(await health.admit('kc')).toEqual({ ok: false, reason: 'dead_credential' });
    // 换 Key 后成功调用自愈：attempt_start（无渠道键的 first_chunk 借它记账）
    emit({ type: 'attempt_start', requestId: 'r3', channelKey: 'kc', attempt: 1, atMs: 1 });
    emit({ type: 'first_chunk', requestId: 'r3', atMs: 2 });
    await flush();
    expect(await health.admit('kc')).toEqual({ ok: true });
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
    expect(await health.admit('ks')).toEqual({ ok: false, reason: 'circuit_open' });
    // 用户取消/停机不进熔断状态机（v1 B6：client_disconnect/server_draining 非渠道问题）
    emit({ type: 'aborted', requestId: 'r4', reason: 'client_disconnect' });
    expect(await health.admit('other')).toEqual({ ok: true });
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
    // 初版只在这两个终态清 currentChannel——映射随请求量无界增长；且同 requestId 迟到的
    // first_chunk 会借残留映射把成功记到已终态的渠道上（误自愈）。
    const store = createMemoryHealthStore();
    const health = createChannelHealth({ store, config });
    const { ai, emit } = fakeAi();
    health.attach(ai);
    // 先把 kc 打成死凭据（2 次 invalid）
    emit({
      type: 'failed',
      requestId: 'r0',
      channelKey: 'kc',
      error: upstreamError('invalid_api_key'),
    });
    emit({
      type: 'failed',
      requestId: 'r0b',
      channelKey: 'kc',
      error: upstreamError('invalid_api_key'),
    });
    await flush();
    expect(await health.admit('kc')).toEqual({ ok: false, reason: 'dead_credential' });
    // 空完成终态序列：attempt_start 登记 → empty_completion 终态（映射应被清理）
    emit({ type: 'attempt_start', requestId: 'rx', channelKey: 'kc', attempt: 1, atMs: 1 });
    emit({ type: 'empty_completion', requestId: 'rx', channelKey: 'kc', attempt: 1 });
    // 同 requestId 迟到的 first_chunk：映射已清 → 不记账（泄漏形态会误自愈死凭据）
    emit({ type: 'first_chunk', requestId: 'rx', atMs: 2 });
    await flush();
    expect(await health.admit('kc')).toEqual({ ok: false, reason: 'dead_credential' });
  });

  it('终态事件序列后映射清空：success/failed/empty_completion 各自终态均清理（Map 不残留）', async () => {
    const store = createMemoryHealthStore();
    const health = createChannelHealth({ store, config });
    const { ai, emit } = fakeAi();
    health.attach(ai);
    // 三条请求各走一类终态；attempt_start 渠道先记 1 次死凭据失败
    //（consecutiveFailures=1）。终态后同 requestId 迟到的 first_chunk 若借残留映射
    // 记成功，会把该渠道计数清零（version 递增）——据此断言映射已被终态清理。
    // ra：换渠后成功（attempt 渠道 ≠ success 渠道——映射应清成 success 后无键）
    emit({
      type: 'failed',
      requestId: 'ra-warm',
      channelKey: 'ka1',
      error: upstreamError('invalid_api_key'),
    });
    emit({ type: 'attempt_start', requestId: 'ra', channelKey: 'ka1', attempt: 1, atMs: 1 });
    emit({ type: 'success', requestId: 'ra', channelKey: 'ka2', durationMs: 5 });
    // rb：failed 终态
    emit({
      type: 'failed',
      requestId: 'rb-warm',
      channelKey: 'kb',
      error: upstreamError('invalid_api_key'),
    });
    emit({ type: 'attempt_start', requestId: 'rb', channelKey: 'kb', attempt: 1, atMs: 1 });
    emit({
      type: 'failed',
      requestId: 'rb',
      channelKey: 'kb',
      error: upstreamError('network'),
    });
    // rc：empty_completion 终态
    emit({
      type: 'failed',
      requestId: 'rc-warm',
      channelKey: 'kc2',
      error: upstreamError('invalid_api_key'),
    });
    emit({ type: 'attempt_start', requestId: 'rc', channelKey: 'kc2', attempt: 1, atMs: 1 });
    emit({ type: 'empty_completion', requestId: 'rc', channelKey: 'kc2', attempt: 1 });
    await flush(); // 落三渠道失败计数（version=1、consecutiveFailures=1）
    emit({ type: 'first_chunk', requestId: 'ra', atMs: 9 });
    emit({ type: 'first_chunk', requestId: 'rb', atMs: 9 });
    emit({ type: 'first_chunk', requestId: 'rc', atMs: 9 });
    await flush();
    for (const key of ['credential:ka1', 'credential:kb', 'credential:kc2']) {
      const state = await store.getState<DeadCredentialState>(key);
      expect(state, key).toMatchObject({ status: 'valid', consecutiveFailures: 1, version: 1 });
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
    expect(await health.admit('k')).toEqual({ ok: true }); // fail-open：健康检查不作可用性单点
  });
});
