import { describe, expect, it } from 'vitest';
import { isBusinessError } from '@tillgate/errors';
import {
  dispatchFailure,
  runCandidateLoop,
  type AttemptOutcome,
  type ExecutionDeps,
} from '../src/application/failover';
import { createChannelHealth } from '../src/health/channel-health';
import { createMemoryHealthStore } from '../src/adapters/state-memory';
import { defaultInferenceDefaults } from '../src/config';
import { noopTrace } from '../src/ports/trace';
import {
  baseAuth,
  channel,
  fakeBilling,
  fakeCatalog,
  fakeUpstream,
  mapping,
  upstreamError,
} from './harness';
import type { PassthroughDelivered } from '../src/application/failover';
import type { PreparedRequest } from '../src/application/quote';

const healthConfig = {
  breaker: { windowMs: 60_000, failureThreshold: 5, cooldownMs: 300_000, halfOpenProbe: true },
  deadCredential: { failureThreshold: 3, windowMs: 3_600_000 },
};

function preparedOf(candidates: PreparedRequest['candidates']): PreparedRequest {
  return {
    requestId: 'req-1',
    auth: baseAuth,
    externalModel: 'gpt-x',
    body: { model: 'gpt-x' },
    upstreamBody: { model: 'gpt-x' },
    endpoint: 'chat',
    outputCap: 100,
    inputUpperBound: 500,
    inputEstimate: 300,
    candidates,
  };
}

function candidateOf(mappingId: number, realModel: string): PreparedRequest['candidates'][number] {
  const m = mapping({ mappingId, externalModel: 'gpt-x', realModel });
  return {
    mappingId: m.mappingId,
    externalModel: m.externalModel,
    realModel: m.realModel,
    inputPrice: m.inputPrice,
    cacheInputPrice: m.cacheInputPrice,
    cacheWritePrice: m.cacheWritePrice,
    outputPrice: m.outputPrice,
    unitPrice: m.unitPrice,
    pricingUnit: m.pricingUnit,
    unitUpperBound: m.unitUpperBound,
    coefficient: m.coefficient,
    billingPolicyFingerprint: m.billingPolicyFingerprint,
  };
}

/** 组装循环环境：catalog 给两候选各 1-2 渠道；upstream/billing/health 可编程 */
function setup(
  opts: {
    channelsByReal?: Record<string, ReturnType<typeof channel>[]>;
  } = {},
) {
  // priority 5/4/0 严格分层——测试内顺序确定（同层加权随机会引入非确定性）
  const chA = channel({ channelId: 1, channelName: 'ch-a', priority: 5 });
  const chB = channel({ channelId: 2, channelName: 'ch-b', priority: 4 });
  const chC = channel({ channelId: 3, channelName: 'ch-c', priority: 0 });
  const channelsByReal = opts.channelsByReal ?? {
    'real-1': [chA, chB],
    'real-2': [chC],
  };
  const catalog = fakeCatalog({}, channelsByReal);
  const billing = fakeBilling();
  const upstream = fakeUpstream();
  const health = createChannelHealth({ store: createMemoryHealthStore(), config: healthConfig });
  const deps: ExecutionDeps = {
    catalog,
    billing: billing.port,
    upstream: upstream.port,
    health,
    trace: noopTrace,
    defaults: defaultInferenceDefaults(),
  };
  return { deps, billing, upstream, health, chA, chB, chC, channelsByReal };
}

describe('application/failover：候选 × 渠道双层循环', () => {
  it('switch_channel → 换下一渠道；next_candidate → 换候选；respond → 返回', async () => {
    const { deps } = setup();
    const attempts: string[] = [];
    const outcome = await runCandidateLoop(
      deps,
      preparedOf([candidateOf(1, 'real-1'), candidateOf(2, 'real-2')]),
      'req-1',
      0,
      undefined,
      async (ctx): Promise<AttemptOutcome<string>> => {
        attempts.push(`${ctx.candidate.realModel}/${ctx.channel.channelName}`);
        if (ctx.channel.channelName === 'ch-a') return { kind: 'switch_channel', code: 'network' };
        if (ctx.candidate.realModel === 'real-1') {
          return { kind: 'next_candidate', code: 'upstream_error' };
        }
        return { kind: 'respond', value: 'DONE' };
      },
    );
    expect(outcome).toBe('DONE');
    expect(attempts).toEqual(['real-1/ch-a', 'real-1/ch-b', 'real-2/ch-c']);
  });

  it('渠道加权调度按 priority 分层（高 priority 渠道先试）', async () => {
    const { deps } = setup();
    const order: number[] = [];
    await runCandidateLoop(
      deps,
      preparedOf([candidateOf(1, 'real-1')]),
      'req-1',
      0,
      undefined,
      async (ctx): Promise<AttemptOutcome<null>> => {
        order.push(ctx.channel.priority);
        return { kind: 'respond', value: null };
      },
    );
    expect(order[0]).toBe(5); // priority 5 层在前
  });

  it('全败：渠道面竭尽（预算/限流/无错误）→ no_available_channel；上游故障 → upstream_failed', async () => {
    const s1 = setup();
    await expect(
      runCandidateLoop(
        s1.deps,
        preparedOf([candidateOf(1, 'real-1')]),
        'req-1',
        0,
        undefined,
        async (): Promise<AttemptOutcome<string>> => ({
          kind: 'switch_channel',
          code: 'channel_budget_exhausted',
        }),
      ),
    ).rejects.toSatisfy(
      (e: unknown) => isBusinessError(e) && e.code === 'inference.no_available_channel',
    );

    const s2 = setup();
    await expect(
      runCandidateLoop(
        s2.deps,
        preparedOf([candidateOf(1, 'real-1')]),
        'req-1',
        0,
        undefined,
        async (): Promise<AttemptOutcome<string>> => ({
          kind: 'next_candidate',
          code: 'upstream_error',
        }),
      ),
    ).rejects.toSatisfy(
      (e: unknown) => isBusinessError(e) && e.code === 'inference.upstream_failed',
    );
    // 全败必发 request_failed 三路释放信号（reason 归一）
    expect(s2.billing.signals.at(-1)).toMatchObject({
      type: 'request_failed',
      requestId: 'req-1',
      reason: 'upstream_error',
    });
    const s3 = setup();
    s3.billing.onReserve(async () => false); // 全渠道预算拒绝
    await expect(
      runCandidateLoop(
        s3.deps,
        preparedOf([candidateOf(1, 'real-1')]),
        'req-1',
        0,
        undefined,
        async (): Promise<AttemptOutcome<string>> => ({ kind: 'respond', value: 'never' }),
      ),
    ).rejects.toSatisfy(
      (e: unknown) => isBusinessError(e) && e.code === 'inference.no_available_channel',
    );
    expect(s3.billing.signals.at(-1)).toMatchObject({
      type: 'request_failed',
      reason: 'no_available_channel',
    });
  });

  it('upstream_started 只在首次成功预留后发一次（租约起点）；reserveChannel 拒绝不发', async () => {
    const s = setup();
    s.billing.onReserve(async () => false);
    await expect(
      runCandidateLoop(
        s.deps,
        preparedOf([candidateOf(1, 'real-1')]),
        'req-1',
        0,
        undefined,
        async (): Promise<AttemptOutcome<string>> => ({ kind: 'respond', value: 'x' }),
      ),
    ).rejects.toSatisfy((e: unknown) => isBusinessError(e));
    expect(s.billing.signals).toHaveLength(1); // 只有 request_failed，无 upstream_started
    expect(s.billing.reserves).toHaveLength(2); // 两个渠道都试过预留
  });

  it('admit 拒绝（熔断 open）→ 换渠不计尝试；B13：circuit_open 全败归渠道面竭尽（no_available_channel）', async () => {
    const s = setup();
    // 手工把 ch-a/ch-b 的健康键打熔断（同 host 共享键——B2 语义）
    const store = createMemoryHealthStore();
    const health = createChannelHealth({ store, config: healthConfig });
    const deps: ExecutionDeps = { ...s.deps, health };
    const key = 'breaker:openai-compatible://up.example.com'; // 机器级键带 breaker: 前缀
    await store.compareAndSet(
      key,
      0,
      {
        state: 'open',
        failures: [],
        windowStart: 0,
        cooldownUntil: Date.now() + 60_000,
        version: 1,
      },
      60_000,
    );
    const tried: string[] = [];
    await expect(
      runCandidateLoop(
        deps,
        preparedOf([candidateOf(1, 'real-1')]),
        'req-1',
        0,
        undefined,
        async (ctx): Promise<AttemptOutcome<string>> => {
          tried.push(ctx.channel.channelName);
          return { kind: 'respond', value: 'x' };
        },
      ),
    ).rejects.toSatisfy(
      (e: unknown) => isBusinessError(e) && e.code === 'inference.no_available_channel',
    );
    expect(tried).toEqual([]); // 渠道全被健康检查跳过（无上游调用）→ 渠道面竭尽而非上游故障
  });

  it('渠道维限流钩子拒绝 → 换渠并记 rate_limit_exceeded；预留不发生', async () => {
    const s = setup();
    const deps: ExecutionDeps = {
      ...s.deps,
      admitChannel: async () => false,
    };
    await expect(
      runCandidateLoop(
        deps,
        preparedOf([candidateOf(1, 'real-1')]),
        'req-1',
        0,
        undefined,
        async (): Promise<AttemptOutcome<string>> => ({ kind: 'respond', value: 'x' }),
      ),
    ).rejects.toSatisfy(
      (e: unknown) => isBusinessError(e) && e.code === 'inference.no_available_channel',
    );
    expect(s.billing.reserves).toHaveLength(0);
  });

  it('上游 4xx 透传（respond 终局）：request_failed 收尾后原码返回', async () => {
    const s = setup();
    s.upstream.onChat(async () => ({
      ok: false,
      error: upstreamError('invalid_request', { status: 400, message: 'bad shape' }),
      durationMs: 5,
    }));
    const delivered = await runCandidateLoop<Record<string, unknown> | PassthroughDelivered>(
      s.deps,
      preparedOf([candidateOf(1, 'real-1')]),
      'req-1',
      0,
      undefined,
      async (ctx): Promise<AttemptOutcome<Record<string, unknown> | PassthroughDelivered>> => {
        const result = await s.deps.upstream.chat(ctx.channel, {
          requestId: ctx.requestId,
          externalModel: 'gpt-x',
          realModel: ctx.candidate.realModel,
          endpoint: 'chat',
          body: {},
          deadlineMs: 1_000,
        });
        if (result.ok) return { kind: 'respond', value: { ok: true } };
        return dispatchFailure(s.deps, ctx, result.error);
      },
    );
    expect(delivered).toMatchObject({
      ok: true,
      passthrough: true,
      status: 400,
      code: 'invalid_request',
      message: 'bad shape',
    });
    expect(s.billing.signals.at(-1)).toMatchObject({
      type: 'request_failed',
      reason: 'invalid_request',
    });
  });
});
