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
import { routingPolicySchema } from '../src/routing/policy';
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
import type { PassthroughDelivered } from '../src/application/dispatch';
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

/** 组装循环环境：catalog 给两候选各 1-2 渠道；upstream/billing/health/memory 可编程 */
function setup(
  opts: {
    channelsByReal?: Record<string, ReturnType<typeof channel>[]>;
    memoryStore?: ReturnType<typeof createMemoryHealthStore>;
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
  const memoryStore = opts.memoryStore ?? createMemoryHealthStore();
  // 本文件场景均假设智能路由开启（failover 生效——单渠道直连见 single-track.test）
  const policy = staticRoutingPolicy(routingPolicySchema.parse({ enabled: true }));
  const memory = createRoutingMemory({ store: memoryStore, policy });
  const deps: ExecutionDeps = {
    catalog,
    billing: billing.port,
    upstream: upstream.port,
    health,
    memory,
    policy,
    trace: noopTrace,
    defaults: defaultInferenceDefaults(),
  };
  return { deps, billing, upstream, health, memory, memoryStore, chA, chB, chC, channelsByReal };
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
    // 信号 reason 保留真实终因（出站信封才做竭尽归一）——排障粒度不丢失
    expect(s3.billing.signals.at(-1)).toMatchObject({
      type: 'request_failed',
      reason: 'channel_budget_exhausted',
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
    // 手工把 ch-a/ch-b 的健康键打熔断（同 host 共享同一健康键）
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
          upstreamModel: ctx.channel.upstreamModel,
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

describe('模型维准入钩子（admitModel）与渠道钩子作用域', () => {
  it('admitModel 拒绝主模型 → 整候选跳过（不进渠道环），fallback 候选接手', async () => {
    const { deps } = setup();
    const seen: Array<{ realModel: string; estimatedTokens: number; requestId: string }> = [];
    deps.admitModel = async (candidate, estimatedTokens, requestId) => {
      seen.push({ realModel: candidate.realModel, estimatedTokens, requestId });
      return candidate.realModel !== 'real-1';
    };
    const attempts: string[] = [];
    const outcome = await runCandidateLoop(
      deps,
      preparedOf([candidateOf(1, 'real-1'), candidateOf(2, 'real-2')]),
      'req-9',
      0,
      undefined,
      async (ctx): Promise<AttemptOutcome<string>> => {
        attempts.push(ctx.candidate.realModel);
        return { kind: 'respond', value: 'OK' };
      },
    );
    expect(outcome).toBe('OK');
    expect(attempts).toEqual(['real-2']); // real-1 候选整体被跳过（连渠道解析都不进）
    // 钩子入参：候选 realModel + 敞口口径估算（inputUpperBound 500 + outputCap 100）+ requestId
    expect(seen[0]).toEqual({ realModel: 'real-1', estimatedTokens: 600, requestId: 'req-9' });
    expect(seen[1]).toMatchObject({ realModel: 'real-2' });
  });

  it('全部候选被模型维限流拒绝 → no_available_channel 终结（rate_limit 计入竭尽码）', async () => {
    const { deps } = setup();
    deps.admitModel = async () => false;
    await expect(
      runCandidateLoop(
        deps,
        preparedOf([candidateOf(1, 'real-1'), candidateOf(2, 'real-2')]),
        'req-1',
        0,
        undefined,
        async (): Promise<AttemptOutcome<string>> => ({ kind: 'respond', value: 'x' }),
      ),
    ).rejects.toThrow(/no channel available/i);
  });

  it('admitChannel 钩子携带 requestId（渠道 TPM 预占作用域）', async () => {
    const { deps } = setup();
    const seenRids: string[] = [];
    deps.admitChannel = async (_channel, _estimatedTokens, requestId) => {
      seenRids.push(requestId);
      return true;
    };
    await runCandidateLoop(
      deps,
      preparedOf([candidateOf(1, 'real-1')]),
      'req-rid',
      0,
      undefined,
      async (): Promise<AttemptOutcome<string>> => ({ kind: 'respond', value: 'v' }),
    );
    expect(seenRids).toEqual(['req-rid']);
  });
});

/** 全渠道 429 的 attempt 桩（等待轮回归件共用——外提避免循环内重建闭包） */
const allRateLimited = async (): Promise<AttemptOutcome<string>> =>
  ({ kind: 'switch_channel', code: 'rate_limited' }) as const;

/** fire-and-forget 记账面的 flush（微任务 + 宏任务各一拍） */
const flush = async () => {
  await Promise.resolve();
  await new Promise((r) => {
    setTimeout(r, 0);
  });
};

describe('跨请求路由记忆（惩罚箱 / 模型死记忆 / 死凭据 channel 维）', () => {
  it('429 失败记账后，下个请求直接跳过该渠道（零重复撞击）', async () => {
    const s = setup();
    // 请求 1：ch-a 429 → dispatchFailure 记惩罚 → 换 ch-b 成功
    await runCandidateLoop<Record<string, unknown> | PassthroughDelivered>(
      s.deps,
      preparedOf([candidateOf(1, 'real-1')]),
      'req-1',
      0,
      undefined,
      async (ctx): Promise<AttemptOutcome<Record<string, unknown> | PassthroughDelivered>> => {
        if (ctx.channel.channelName === 'ch-a') {
          return dispatchFailure(
            s.deps,
            ctx,
            upstreamError('rate_limited', { status: 429, retryAfterMs: 10_000 }),
          );
        }
        return { kind: 'respond', value: { ok: true } };
      },
    );
    await flush();
    expect(await s.memory.penalized(1)).toBe(true);
    // 请求 2：ch-a 被 penalty 门跳过（无上游调用），直接 ch-b
    const tried: string[] = [];
    await runCandidateLoop(
      s.deps,
      preparedOf([candidateOf(1, 'real-1')]),
      'req-2',
      0,
      undefined,
      async (ctx): Promise<AttemptOutcome<string>> => {
        tried.push(ctx.channel.channelName);
        return { kind: 'respond', value: 'OK' };
      },
    );
    expect(tried).toEqual(['ch-b']);
  });

  it('quota_exhausted 记账进惩罚箱；4xx 透传不记任何惩罚', async () => {
    const s = setup();
    const outcome = await dispatchFailure(
      s.deps,
      {
        prepared: preparedOf([candidateOf(1, 'real-1')]),
        requestId: 'req-q',
        requestStartedAt: 0,
        candidate: candidateOf(1, 'real-1'),
        channel: s.chA,
        channelAttempt: 1,
        stickyKey: 'sticky:test',
      },
      upstreamError('quota_exhausted', { status: 402 }),
    );
    expect(outcome.kind).toBe('switch_channel');
    await flush();
    expect(await s.memory.penalized(1)).toBe(true);

    const s2 = setup();
    await dispatchFailure(
      s2.deps,
      {
        prepared: preparedOf([candidateOf(1, 'real-1')]),
        requestId: 'req-p',
        requestStartedAt: 0,
        candidate: candidateOf(1, 'real-1'),
        channel: s2.chA,
        channelAttempt: 1,
        stickyKey: 'sticky:test',
      },
      upstreamError('invalid_request', { status: 400 }),
    );
    await flush();
    expect(await s2.memory.penalized(1)).toBe(false);
  });

  it('死凭据按 channel 维：ch-a 连续 3 次 401 后跳过，同 host 的 ch-b 不连坐', async () => {
    const s = setup();
    for (let i = 0; i < 3; i++) {
      await dispatchFailure(
        s.deps,
        {
          prepared: preparedOf([candidateOf(1, 'real-1')]),
          requestId: `req-d${i}`,
          requestStartedAt: 0,
          candidate: candidateOf(1, 'real-1'),
          channel: s.chA,
          channelAttempt: 1,
          stickyKey: 'sticky:test',
        },
        upstreamError('invalid_api_key', { status: 401 }),
      );
    }
    await flush();
    const admission = await s.health.admit('openai-compatible://up.example.com', 2); // 同 host 另一渠道
    expect(admission).toEqual({ ok: true });
    const dead = await s.health.admit('openai-compatible://up.example.com', 1);
    expect(dead).toEqual({ ok: false, reason: 'dead_credential' });
  });

  it('候选全渠道连续耗尽达阈值 → 死记忆跳过该候选（fallback 接手）', async () => {
    const s = setup();
    // 3 个请求：real-1 全渠道耗尽（next_candidate 也算候选失败）
    for (let i = 0; i < 3; i++) {
      await runCandidateLoop(
        s.deps,
        preparedOf([candidateOf(1, 'real-1'), candidateOf(2, 'real-2')]),
        `req-m${i}`,
        0,
        undefined,
        async (ctx): Promise<AttemptOutcome<string>> =>
          ctx.candidate.realModel === 'real-1'
            ? { kind: 'next_candidate', code: 'upstream_error' }
            : { kind: 'respond', value: 'OK' },
      );
    }
    await flush();
    expect(await s.memory.deadModel('real-1')).toBe(true);
    // 第 4 个请求：real-1 候选整体跳过（无渠道解析），直接 real-2
    const attempted: string[] = [];
    await runCandidateLoop(
      s.deps,
      preparedOf([candidateOf(1, 'real-1'), candidateOf(2, 'real-2')]),
      'req-m4',
      0,
      undefined,
      async (ctx): Promise<AttemptOutcome<string>> => {
        attempted.push(ctx.candidate.realModel);
        return { kind: 'respond', value: 'OK' };
      },
    );
    expect(attempted).toEqual(['real-2']);
  });

  it('onAttempts 观察者：换渠场景上报真实尝试次数（request_logs.attempts 数据源）', async () => {
    const s = setup();
    const seen: number[] = [];
    const attempts: string[] = [];
    await runCandidateLoop(
      s.deps,
      preparedOf([candidateOf(1, 'real-1')]),
      'req-att',
      0,
      undefined,
      async (ctx): Promise<AttemptOutcome<string>> => {
        attempts.push(ctx.channel.channelName ?? '');
        return ctx.channel.channelName === 'ch-a'
          ? { kind: 'switch_channel', code: 'upstream_error' }
          : { kind: 'respond', value: 'OK' };
      },
      (total) => seen.push(total),
    );
    expect(attempts).toEqual(['ch-a', 'ch-b']); // 两渠道各一次真实尝试
    expect(seen).toEqual([1, 2]); // 每次尝试后上报累计值
  });

  it('回归（Bug#4 豁免）：客户端取消/网关停机中止不记死记忆——渠道无责不连坐', async () => {
    // canceled（客户端断连）/server_draining（网关停机）不是渠道健康证据：
    // 多次取消不得把模型判死（旧实现无条件计入 healthEvidence）
    const s = setup();
    for (let i = 0; i < 5; i++) {
      await expect(
        runCandidateLoop(
          s.deps,
          preparedOf([candidateOf(1, 'real-1')]),
          `req-cx${i}`,
          0,
          undefined,
          async (): Promise<AttemptOutcome<string>> =>
            ({ kind: 'next_candidate', code: 'canceled' }) as const,
        ),
      ).rejects.toThrow();
    }
    await flush();
    expect(await s.memory.deadModel('real-1')).toBe(false);
    // 对照：真实上游失败仍正常计数（豁免不弱化健康证据）
    await expect(
      runCandidateLoop(
        s.deps,
        preparedOf([candidateOf(1, 'real-1')]),
        'req-cx-ctl',
        0,
        undefined,
        async (): Promise<AttemptOutcome<string>> =>
          ({ kind: 'next_candidate', code: 'upstream_error' }) as const,
      ),
    ).rejects.toThrow();
    await flush();
    expect(await s.memory.deadModel('real-1')).toBe(false); // 1 次真实失败 < 阈值 3
  });

  it('回归：等待重试轮不重复计死记忆——每请求每候选恰一次（两轮全 429 不判死）', async () => {
    // 旧缺陷：runPass 每轮末各记一次 recordModelFailure → 触发 maybeWaitAndRetry 的
    // 请求记 2 次，两个全 429 请求即达阈值 3，把模型对所有用户判死 60s
    // （model-dead.ts 契约「一次请求最多记一次」被违反）
    const s = setup();
    // 渠道在惩罚箱（~1s 恢复 ≤ maxWaitMs=2s）→ 全败 429 后触发等待重试轮
    s.memory.recordPenalty(
      (s.channelsByReal['real-1'] ?? [])[0]?.channelId ?? 1,
      'rate_limited',
      1_000,
    );
    for (let i = 0; i < 2; i++) {
      await expect(
        runCandidateLoop(
          s.deps,
          preparedOf([candidateOf(1, 'real-1')]),
          `req-w${i}`,
          0,
          undefined,
          allRateLimited,
        ),
      ).rejects.toThrow();
    }
    await flush();
    // 修复后：2 请求 × 1 次 = 2 < 阈值 3 → 不判死（旧实现 2×2=4 ≥ 3 → 判死）
    expect(await s.memory.deadModel('real-1')).toBe(false);
    // 记账未被弱化：第 3 个请求（3 次）仍达阈值判死
    await expect(
      runCandidateLoop(
        s.deps,
        preparedOf([candidateOf(1, 'real-1')]),
        'req-w3',
        0,
        undefined,
        allRateLimited,
      ),
    ).rejects.toThrow();
    await flush();
    expect(await s.memory.deadModel('real-1')).toBe(true);
  });

  it('候选成功结算清零死记忆（自愈快路径）', async () => {
    const s = setup();
    for (let i = 0; i < 2; i++) {
      await runCandidateLoop(
        s.deps,
        preparedOf([candidateOf(1, 'real-1')]),
        `req-s${i}`,
        0,
        undefined,
        async (): Promise<AttemptOutcome<string>> => ({ kind: 'respond', value: 'OK' }),
      );
    }
    await flush();
    // respond 成功（模拟 settle 面记账）
    s.memory.recordModelSuccess('real-1');
    await flush();
    expect(await s.memory.deadModel('real-1')).toBe(false);
  });

  it('P2 回归：请求维门拒绝连续耗尽不判死模型（预算硬闸 / 渠道准入钩子）', async () => {
    // 预算硬闸按「本请求敞口估算 vs 渠道剩余」拒绝——大请求 3 连发不得把模型
    // 判死（旧实现无条件 recordModelFailure → 误伤所有用户 60s）
    const s1 = setup();
    s1.billing.onReserve(async () => false);
    for (let i = 0; i < 3; i++) {
      await expect(
        runCandidateLoop(
          s1.deps,
          preparedOf([candidateOf(1, 'real-1')]),
          `req-b${i}`,
          0,
          undefined,
          async (): Promise<AttemptOutcome<string>> => ({ kind: 'respond', value: 'never' }),
        ),
      ).rejects.toSatisfy(
        (e: unknown) => isBusinessError(e) && e.code === 'inference.no_available_channel',
      );
    }
    await flush();
    expect(await s1.memory.deadModel('real-1')).toBe(false);

    // 渠道准入钩子（app 装配 RPM/TPM 预占——TPM 按请求估算，同属请求维信号）
    const s2 = setup();
    s2.deps.admitChannel = async () => false;
    for (let i = 0; i < 3; i++) {
      await expect(
        runCandidateLoop(
          s2.deps,
          preparedOf([candidateOf(1, 'real-1')]),
          `req-r${i}`,
          0,
          undefined,
          async (): Promise<AttemptOutcome<string>> => ({ kind: 'respond', value: 'never' }),
        ),
      ).rejects.toSatisfy(
        (e: unknown) => isBusinessError(e) && e.code === 'inference.no_available_channel',
      );
    }
    await flush();
    expect(await s2.memory.deadModel('real-1')).toBe(false);
  });

  it('P2 回归（防过滤过宽）：候选内存在真实上游失败仍计数（伴请求维拒绝不变）', async () => {
    const s = setup();
    // ch-a 上游真实失败（upstream_error）+ ch-b 渠道准入钩子拒（请求维）——
    // 候选耗尽必须计数：过滤只豁免「全部渠道都只有请求维拒绝」的候选
    s.deps.admitChannel = async (ch) => ch.channelName !== 'ch-b';
    for (let i = 0; i < 3; i++) {
      await expect(
        runCandidateLoop(
          s.deps,
          preparedOf([candidateOf(1, 'real-1')]),
          `req-mix${i}`,
          0,
          undefined,
          async (ctx): Promise<AttemptOutcome<string>> =>
            ctx.channel.channelName === 'ch-a'
              ? { kind: 'switch_channel', code: 'upstream_error' }
              : { kind: 'respond', value: 'never' },
        ),
      ).rejects.toSatisfy(
        // 终局归因取最后失败（ch-b 准入拒绝覆盖 upstream_error → 渠道面竭尽）
        (e: unknown) => isBusinessError(e) && e.code === 'inference.no_available_channel',
      );
    }
    await flush();
    expect(await s.memory.deadModel('real-1')).toBe(true);
  });
});

describe('dispatchFailure 出站脱敏（单点收口——流式/非流式/任务三路共用）', () => {
  function ctxOf() {
    const chA = channel({ channelId: 1, channelName: 'ch-a' });
    return {
      prepared: preparedOf([candidateOf(1, 'real-1'), candidateOf(2, 'real-2')]),
      requestId: 'req-s',
      requestStartedAt: 0,
      candidate: candidateOf(1, 'real-1'),
      channel: chA,
      channelAttempt: 1,
      stickyKey: 'sticky:test',
    };
  }

  it('passthrough message：realModel → 对外名替换 + 内部寻址遮蔽（原始 message 不出站）', async () => {
    const { deps } = setup();
    const raw =
      'deployment real-1 at https://internal-node-7.prod:8443/v1 not found (tried real-2)';
    const outcome = await dispatchFailure(
      deps,
      ctxOf(),
      upstreamError('invalid_request', { status: 400, message: raw }),
    );
    expect(outcome.kind).toBe('respond');
    const { value } = outcome as { value: PassthroughDelivered };
    // 两个候选的 realModel（real-1/real-2）都映射到各自对外名（此处同为 gpt-x）
    expect(value.message).toBe('deployment gpt-x at [redacted] not found (tried gpt-x)');
  });

  it('事件面/日志保真：billing 信号与 span 不因脱敏改变；超长 message 截断', async () => {
    const { deps } = setup();
    const long = `real-1 ${'x'.repeat(600)}`;
    const outcome = await dispatchFailure(
      deps,
      ctxOf(),
      upstreamError('invalid_request', { status: 400, message: long }),
    );
    const { value } = outcome as { value: PassthroughDelivered };
    expect(value.message?.startsWith('gpt-x x')).toBe(true);
    expect(value.message?.length).toBeLessThanOrEqual(512);
  });

  it('message === kind 时仍不带 message 字段（无可脱敏面）', async () => {
    const { deps } = setup();
    const outcome = await dispatchFailure(
      deps,
      ctxOf(),
      upstreamError('invalid_request', { status: 400 }),
    );
    const { value } = outcome as { value: PassthroughDelivered };
    expect(value.message).toBeUndefined();
  });

  it('渠道绑定异名也进脱敏 needle：厂商拼写（如 vendor-a/real-1）→ 对外名', async () => {
    const { deps } = setup();
    const ctx = {
      ...ctxOf(),
      channel: channel({ channelId: 1, channelName: 'ch-a', upstreamModel: 'vendor-a/real-1' }),
    };
    const outcome = await dispatchFailure(
      deps,
      ctx,
      upstreamError('invalid_request', {
        status: 400,
        message: 'model vendor-a/real-1 is deprecated',
      }),
    );
    const { value } = outcome as { value: PassthroughDelivered };
    // 旧实现只脱敏候选 realModel——厂商拼写原样出站，泄漏绑定异名
    expect(value.message).toBe('model gpt-x is deprecated');
  });
});
