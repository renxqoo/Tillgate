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
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('health/channel-health：AiEvent 订阅者（§3.6 零运维状态的 inference 侧）', () => {
  it('健康键 = protocol://host（与 ai 事件 channelKey 同算法）；坏 baseUrl 兜底 unknown', () => {
    expect(channelHealthKey({ protocol: 'openai-compatible', baseUrl: 'https://a.com/v1' })).toBe(
      'openai-compatible://a.com',
    );
    expect(channelHealthKey({ protocol: 'anthropic', baseUrl: '::::' })).toBe(
      'anthropic://unknown',
    );
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
