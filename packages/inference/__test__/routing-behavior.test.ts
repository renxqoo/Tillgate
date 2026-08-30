import { describe, expect, it } from 'vitest';
import {
  runCandidateLoop,
  type AttemptOutcome,
  type ExecutionDeps,
} from '../src/application/failover';
import { createChannelHealth } from '../src/health/channel-health';
import { createRoutingMemory } from '../src/health/routing-memory';
import { createMemoryStickyStore, staticRoutingPolicy } from '../src/ports/routing';
import type * as z from 'zod';
import { routingPolicySchema } from '../src/routing/policy';

/** 智能路由开启态的策略（本文件场景均假设 failover 生效——单渠道直连见 single-track.test） */
const smartPolicy = (overrides: z.input<typeof routingPolicySchema> = {}) =>
  routingPolicySchema.parse({ enabled: true, ...overrides });

import { createMemoryHealthStore } from '../src/adapters/state-memory';
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
import type { PreparedRequest } from '../src/application/quote';

const healthConfig = {
  breaker: { windowMs: 60_000, failureThreshold: 5, cooldownMs: 300_000, halfOpenProbe: true },
  deadCredential: { failureThreshold: 3, windowMs: 3_600_000 },
};

const flush = async () => {
  await Promise.resolve();
  await new Promise((r) => {
    setTimeout(r, 0);
  });
};

function preparedOf(
  candidates: PreparedRequest['candidates'],
  body: Record<string, unknown> = { model: 'gpt-x' },
): PreparedRequest {
  return {
    requestId: 'req-1',
    auth: baseAuth,
    externalModel: 'gpt-x',
    body,
    upstreamBody: body,
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

interface BehaviorSetup {
  deps: ExecutionDeps;
  upstream: ReturnType<typeof fakeUpstream>;
}

/** 单渠道世界（B1/B3 场景）+ 可覆写 policy */
function setupSingle(policy = smartPolicy()): BehaviorSetup {
  const ch = channel({ channelId: 1, channelName: 'ch-only', priority: 10 });
  const store = createMemoryHealthStore();
  const upstream = fakeUpstream();
  const deps: ExecutionDeps = {
    catalog: fakeCatalog({}, { 'real-1': [ch] }),
    billing: fakeBilling().port,
    upstream: upstream.port,
    health: createChannelHealth({ store, config: healthConfig }),
    memory: createRoutingMemory({ store, policy: staticRoutingPolicy(policy) }),
    policy: staticRoutingPolicy(policy),
    trace: noopTrace,
    defaults: routingDefaults(),
  };
  return { deps, upstream };
}

import { defaultInferenceDefaults } from '../src/config';
const routingDefaults = defaultInferenceDefaults;

describe('B1 条件惩罚门：全渠道冷却时放行（不再假性 503）', () => {
  it('单渠道冷却期内：放行该渠道尝试上游（上游恢复则成功）', async () => {
    const { deps } = setupSingle();
    // 预涂惩罚（冷却 60s——旧实现此处直接 503）
    deps.memory.recordPenalty(1, 'rate_limited', 60_000);
    await flush();
    expect(await deps.memory.penalized(1)).toBe(true);
    const outcome = await runCandidateLoop(
      deps,
      preparedOf([candidateOf(1, 'real-1')]),
      'req-1',
      0,
      undefined,
      async (): Promise<AttemptOutcome<string>> => ({ kind: 'respond', value: 'OK' }),
    );
    expect(outcome).toBe('OK');
  });

  it('conditionalBypass=false 时保持旧语义（冷却即拒 → 503 渠道面竭尽）', async () => {
    const policy = smartPolicy({ penalty: { conditionalBypass: false } });
    const { deps } = setupSingle(policy);
    deps.memory.recordPenalty(1, 'rate_limited', 60_000);
    await flush();
    await expect(
      runCandidateLoop(
        deps,
        preparedOf([candidateOf(1, 'real-1')]),
        'req-1',
        0,
        undefined,
        async (): Promise<AttemptOutcome<string>> => ({ kind: 'respond', value: 'never' }),
      ),
    ).rejects.toThrow(/no channel available/i);
  });
});

describe('B3 终局有界等待：全败限流 + 最早恢复在窗口内 → 等待重试一轮', () => {
  it('上游先 429（短 Retry-After）后恢复 → 网关内等待后第二轮成功', async () => {
    const policy = smartPolicy({
      penalty: { rateLimitBaseMs: 100, rateLimitMaxMs: 1_000 },
      wait: { enabled: true, maxWaitMs: 5_000 },
    });
    const { deps, upstream } = setupSingle(policy);
    let calls = 0;
    upstream.onChat(async () => {
      calls += 1;
      if (calls <= 1) {
        return {
          ok: false,
          error: upstreamError('rate_limited', { status: 429, retryAfterMs: 120 }),
          durationMs: 1,
        };
      }
      return { ok: true, body: { ok: true }, durationMs: 1 };
    });
    const outcome = await runCandidateLoop(
      deps,
      preparedOf([candidateOf(1, 'real-1')]),
      'req-1',
      0,
      undefined,
      async (ctx): Promise<AttemptOutcome<string>> => {
        const r = await deps.upstream.chat(ctx.channel, {
          requestId: ctx.requestId,
          externalModel: 'gpt-x',
          upstreamModel: ctx.channel.upstreamModel,
          endpoint: 'chat',
          body: {},
          deadlineMs: 1_000,
        });
        if (!r.ok) {
          // dispatchFailure 同款记账（fire-and-forget）+ 换渠 outcome
          deps.memory.recordPenalty(ctx.channel.channelId, 'rate_limited', r.error.retryAfterMs);
          return { kind: 'switch_channel', code: r.error.kind };
        }
        return { kind: 'respond', value: 'OK' };
      },
    );
    expect(outcome).toBe('OK');
    expect(calls).toBeGreaterThanOrEqual(2); // 第一轮 429 → 等待 → 第二轮成功
  }, 15_000);

  it('客户端已断开（signal 预 abort）：不占用等待窗直接以失败收尾', async () => {
    const policy = smartPolicy({
      penalty: { rateLimitBaseMs: 100, rateLimitMaxMs: 1_000 },
      wait: { enabled: true, maxWaitMs: 5_000 },
    });
    const { deps } = setupSingle(policy);
    // 预涂限流冷却（最早恢复 ~120ms——若不预检 abort 会睡满 ~150ms）
    deps.memory.recordPenalty(1, 'rate_limited', 120);
    await flush();
    const controller = new AbortController();
    controller.abort();
    const startedAt = Date.now();
    await expect(
      runCandidateLoop(
        deps,
        preparedOf([candidateOf(1, 'real-1')]),
        'req-abort',
        0,
        controller.signal,
        async (): Promise<AttemptOutcome<string>> => ({
          kind: 'switch_channel',
          code: 'rate_limited',
        }),
      ),
    ).rejects.toThrow(/no channel available/i);
    // 预检命中：不睡等待窗（等待形态 ~150ms；预检形态 < 100ms）
    expect(Date.now() - startedAt).toBeLessThan(100);
  });
});

describe('cache 亲和（sticky scorer）', () => {
  it('结算成功粘滞 → 后续同指纹请求优先落在同渠道（boost 压过层内随机）', async () => {
    const policy = smartPolicy({
      scorers: { cacheAffinity: { enabled: true, boost: 5 } },
    });
    const chA = channel({ channelId: 1, channelName: 'ch-a', priority: 10, weight: 1 });
    const chB = channel({ channelId: 2, channelName: 'ch-b', priority: 10, weight: 1 });
    const store = createMemoryHealthStore();
    const sticky = createMemoryStickyStore();
    const deps: ExecutionDeps = {
      catalog: fakeCatalog({}, { 'real-1': [chA, chB] }),
      billing: fakeBilling().port,
      upstream: fakeUpstream().port,
      health: createChannelHealth({ store, config: healthConfig }),
      memory: createRoutingMemory({ store, policy: staticRoutingPolicy(policy) }),
      policy: staticRoutingPolicy(policy),
      sticky,
      trace: noopTrace,
      defaults: routingDefaults(),
    };
    const body = {
      model: 'gpt-x',
      messages: [{ role: 'user', content: 'same conversation prefix' }],
    };
    const seen: number[] = [];
    const attemptOf =
      (rid: string) =>
      async (
        ctx: Parameters<Parameters<typeof runCandidateLoop<string>>[5]>[0],
      ): Promise<AttemptOutcome<string>> => {
        seen.push(ctx.channel.channelId);
        // 结算成功面（chat settle 同款：死凭据自愈 + 死记忆清零 + sticky 记录）
        const { recordSettleSuccess } = await import('../src/application/failover');
        recordSettleSuccess(deps, {
          channel: ctx.channel,
          candidate: ctx.candidate,
          stickyKey: ctx.stickyKey,
        });
        await flush();
        return { kind: 'respond', value: rid };
      };
    // 请求 1：落任一渠道并粘滞
    await runCandidateLoop(
      deps,
      preparedOf([candidateOf(1, 'real-1')], body),
      'req-1',
      0,
      undefined,
      attemptOf('req-1'),
    );
    const [first] = seen;
    // 粘滞已记录且可读（boost 对排序的影响由 ranker 单测确定性验证）
    const { stickyKeyOf } = await import('../src/routing/sticky');
    const key = stickyKeyOf(
      { auth: baseAuth, body, externalModel: 'gpt-x', endpoint: 'chat' },
      policy.scorers.cacheAffinity.prefixChars,
    );
    await expect(sticky.get(key)).resolves.toBe(first);
    // 不同指纹（不同前缀）不粘
    const body2 = {
      model: 'gpt-x',
      messages: [{ role: 'user', content: 'totally different prefix xyz' }],
    };
    const key2 = stickyKeyOf(
      { auth: baseAuth, body: body2 },
      policy.scorers.cacheAffinity.prefixChars,
    );
    await expect(sticky.get(key2)).resolves.toBe(null);
  });
});
