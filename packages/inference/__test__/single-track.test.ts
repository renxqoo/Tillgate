import { describe, expect, it } from 'vitest';
import { isBusinessError } from '@tillgate/errors';
import {
  runCandidateLoop,
  type AttemptOutcome,
  type ExecutionDeps,
} from '../src/application/failover';
import { dispatchFailure } from '../src/application/dispatch';
import { createChannelHealth } from '../src/health/channel-health';
import { createRoutingMemory } from '../src/health/routing-memory';
import { staticRoutingPolicy } from '../src/ports/routing';
import { createMemoryHealthStore } from '../src/adapters/state-memory';
import { defaultInferenceDefaults } from '../src/config';
import { noopTrace } from '../src/ports/trace';
import { routingPolicySchema } from '../src/routing/policy';
import { baseAuth, channel, fakeBilling, fakeCatalog, fakeUpstream, mapping } from './harness';
import type { PreparedRequest } from '../src/application/quote';

/**
 * 单渠道直连模式规格（policy.enabled=false——用户裁决 D1/D2/D3）：
 *   1. 候选链截断为主模型、渠道确定性取 priority/weight 首名；
 *   2. 首选渠道失败（可换类错误）不换渠道不换候选 → upstream_failed 502 终局；
 *   3. 保护门（死凭据/熔断）照常拒绝且拒绝即终局 → no_available_channel 503；
 *   4. 惩罚箱不写（路由信号停用）。
 */

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

function setup(channels: ReturnType<typeof channel>[]): {
  deps: ExecutionDeps;
  memory: ReturnType<typeof createRoutingMemory>;
  health: ReturnType<typeof createChannelHealth>;
} {
  const store = createMemoryHealthStore();
  const policy = staticRoutingPolicy(routingPolicySchema.parse({ enabled: false }));
  const memory = createRoutingMemory({ store, policy });
  const health = createChannelHealth({ store, config: healthConfig });
  const deps: ExecutionDeps = {
    catalog: fakeCatalog({}, { 'real-1': channels }),
    billing: fakeBilling().port,
    upstream: fakeUpstream().port,
    health,
    memory,
    policy,
    trace: noopTrace,
    defaults: defaultInferenceDefaults(),
  };
  return { deps, memory, health };
}

const chA = () => channel({ channelId: 1, channelName: 'ch-a', priority: 5 });
const chB = () => channel({ channelId: 2, channelName: 'ch-b', priority: 4 });

describe('单渠道直连（policy.enabled=false）', () => {
  it('确定性取 priority 首名：可换类失败不换渠道、fallback 候选不生效 → 502 终局', async () => {
    const { deps } = setup([chA(), chB()]);
    const attempts: string[] = [];
    const thrown = await runCandidateLoop<string>(
      deps,
      preparedOf([candidateOf(1, 'real-1'), candidateOf(2, 'real-2')]),
      'req-1',
      0,
      undefined,
      async (ctx): Promise<AttemptOutcome<string>> => {
        attempts.push(`${ctx.candidate.realModel}/${ctx.channel.channelName}`);
        return { kind: 'switch_channel', code: 'network' };
      },
    ).catch((error: unknown) => error);
    expect(attempts).toEqual(['real-1/ch-a']);
    expect(isBusinessError(thrown)).toBe(true);
    expect(String((thrown as { code?: string }).code)).toBe('inference.upstream_failed');
  });

  it('同 priority 下 weight 大者首选（渠道层排序语义）', async () => {
    const { deps } = setup([
      channel({ channelId: 1, channelName: 'ch-light', priority: 5, weight: 1 }),
      channel({ channelId: 2, channelName: 'ch-heavy', priority: 5, weight: 100 }),
    ]);
    const seen: string[] = [];
    await runCandidateLoop<string>(
      deps,
      preparedOf([candidateOf(1, 'real-1')]),
      'req-1',
      0,
      undefined,
      async (ctx): Promise<AttemptOutcome<string>> => {
        seen.push(ctx.channel.channelName);
        return { kind: 'respond', value: 'DONE' };
      },
    );
    expect(seen).toEqual(['ch-heavy']);
  });

  it('保护门照常拒绝且拒绝即终局：死凭据 → 503 no_available_channel，不试次渠道', async () => {
    const { deps, health } = setup([chA(), chB()]);
    // 记账 fire-and-forget：连续失败达阈值（3）后 tracker 落 invalid 再进请求
    health.recordDeadCredential(1, true);
    health.recordDeadCredential(1, true);
    health.recordDeadCredential(1, true);
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    const attempts: string[] = [];
    const thrown = await runCandidateLoop<string>(
      deps,
      preparedOf([candidateOf(1, 'real-1')]),
      'req-1',
      0,
      undefined,
      async (ctx): Promise<AttemptOutcome<string>> => {
        attempts.push(ctx.channel.channelName);
        return { kind: 'respond', value: 'DONE' };
      },
    ).catch((error: unknown) => error);
    expect(attempts).toEqual([]);
    expect(String((thrown as { code?: string }).code)).toBe('inference.no_available_channel');
  });

  it('惩罚箱不写：上游 429 后无冷却记录（路由信号停用）', async () => {
    const { deps, memory } = setup([chA()]);
    const ctx = {
      prepared: preparedOf([candidateOf(1, 'real-1')]),
      requestId: 'req-1',
      requestStartedAt: 0,
      candidate: candidateOf(1, 'real-1'),
      channel: chA(),
      channelAttempt: 1,
      stickyKey: '',
    };
    await dispatchFailure(deps, ctx, { kind: 'rate_limited', status: 429 } as never);
    expect(await memory.penalized(1)).toBe(false);
  });
});
