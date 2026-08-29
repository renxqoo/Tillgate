import { describe, expect, it } from 'vitest';
import { isBusinessError } from '@tillgate/errors';
import { createInference } from '../src/inference';
import { createMemoryGenerationTaskStore } from '../src/adapters/task-memory';
import { createMemoryHealthStore } from '../src/adapters/state-memory';
import { createMemoryStickyStore, staticRoutingPolicy } from '../src/ports/routing';
import { routingPolicySchema } from '../src/routing/policy';
import { stickyKeyOf } from '../src/routing/sticky';
import type { DeadCredentialState } from '../src/health/dead-credential';
import type { ModelDeadState } from '../src/health/model-dead';
import {
  baseAuth,
  buildInference,
  channel,
  fakeAi,
  fakeBilling,
  fakeCatalog,
  fakeUpstream,
  mapping,
  upstreamError,
} from './harness';

function setup() {
  const ai = fakeAi();
  const upstream = fakeUpstream();
  const billing = fakeBilling();
  const catalog = fakeCatalog(
    {
      'vid-model': mapping({
        mappingId: 21,
        externalModel: 'vid-model',
        realModel: 'vid-real',
        pricingUnit: 'second',
      }),
      'mus-model': mapping({
        mappingId: 22,
        externalModel: 'mus-model',
        realModel: 'mus-real',
        pricingUnit: 'request',
      }),
    },
    {
      'vid-real': [channel({ channelId: 1, channelName: 'ch-video' })],
      'mus-real': [channel({ channelId: 2, channelName: 'ch-music' })],
    },
  );
  const tasks = createMemoryGenerationTaskStore();
  const inference = buildInference({
    ai: ai.ai,
    catalog,
    billing: billing.port,
    upstream: upstream.port,
  });
  return { inference, upstream, billing, tasks, detach: () => inference.close() };
}

describe('application/generation：提交与查询用例', () => {
  it('task_poll（video）：上游提交任务号 → 收据模板持久化（queued）→ 属主可查', async () => {
    const s = setup();
    s.upstream.onSubmit(async () => ({ ok: true, upstreamTaskId: 'up-1' }));
    const outcome = await s.inference.generation.submit({
      requestId: 'gen-1',
      auth: baseAuth,
      kind: 'video',
      body: { model: 'vid-model', prompt: 'dance', duration: 8 },
    });
    expect(outcome).toMatchObject({ ok: true, taskId: expect.any(String) });
    if (!('taskId' in outcome)) throw new Error('unreachable');
    const view = await s.inference.generation.query(baseAuth.userId, outcome.taskId);
    expect(view).toMatchObject({
      kind: 'video',
      status: 'queued',
      params: { model: 'vid-model', prompt: 'dance', duration: 8 },
      upstreamTaskId: 'up-1' as unknown,
    });
    // 授权 TTL = 任务 TTL + 租约宽限；敞口零口径（计量走 units 轴）
    expect(s.billing.authorizations[0]).toMatchObject({ authorizationTtlMs: 3_630_000 });
    s.detach();
  });

  it('task_execute（music）：不经上游提交（仅登记），units 快照按次计量', async () => {
    const s = setup();
    const submitted: number[] = [];
    s.upstream.onSubmit(async (ch) => {
      submitted.push(ch.channelId);
      return { ok: true, upstreamTaskId: 'never' };
    });
    const outcome = await s.inference.generation.submit({
      requestId: 'gen-2',
      auth: baseAuth,
      kind: 'music',
      body: { model: 'mus-model', prompt: 'song', lyrics: '[a]' },
    });
    expect(outcome.ok).toBe(true);
    expect(submitted).toEqual([]); // task_execute 不调上游
    if (!('taskId' in outcome)) throw new Error('unreachable');
    const view = await s.inference.generation.query(baseAuth.userId, outcome.taskId);
    expect(view.params).toEqual({ model: 'mus-model', prompt: 'song', lyrics: '[a]' });
    s.detach();
  });

  it('持久化失败 → billing_receipt_unavailable 且无 request_failed 信号（预留保留交 recover）', async () => {
    const s = setup();
    s.upstream.onSubmit(async () => ({ ok: true, upstreamTaskId: 'up-9' }));
    // 任务存储注入失败实现：总抛错的 store（预留保留语义断言；推进动词在该
    // 场景不可达——submit 在 insert 即抛，不会进入轮询路径）
    const failing = {
      insert: async () => {
        throw new Error('pg down');
      },
      findByOwner: async () => null,
      adminList: async () => ({ rows: [], total: 0 }),
      settledAmounts: async () => new Map<string, string>(),
      expireOverdue: async () => [],
      listActive: async () => [],
      markRunning: async () => false,
      casTerminal: async () => false,
    };
    const inference2 = createInference({
      ai: fakeAi().ai,
      catalog: fakeCatalog(
        { 'vid-model': mapping({ realModel: 'vid-real', pricingUnit: 'second' }) },
        { 'vid-real': [channel()] },
      ),
      billing: s.billing.port,
      store: createMemoryHealthStore(),
      decrypt: (enc) => enc,
      upstream: s.upstream.port,
      tasks: failing,
    });
    const result = await inference2.generation
      .submit({ requestId: 'gen-3', auth: baseAuth, kind: 'video', body: { model: 'vid-model' } })
      .then(
        (v) => v,
        (error: unknown) => error,
      );
    expect(isBusinessError(result) && result.code === 'inference.billing_receipt_unavailable').toBe(
      true,
    );
    // 预留保留：无 request.failed（上游可能已受理，退款归 recover）
    expect(s.billing.signals.filter((e) => e.type === 'request_failed')).toHaveLength(0);
    s.detach();
  });

  it('查询属主隔离：他人任务/不存在一律 task_not_found', async () => {
    const s = setup();
    s.upstream.onSubmit(async () => ({ ok: true, upstreamTaskId: 'up' }));
    const outcome = await s.inference.generation.submit({
      auth: baseAuth,
      kind: 'video',
      body: { model: 'vid-model' },
    });
    if (!('taskId' in outcome)) throw new Error('unreachable');
    await expect(s.inference.generation.query(999, outcome.taskId)).rejects.toSatisfy(
      (e: unknown) => isBusinessError(e) && e.code === 'inference.task_not_found',
    );
    await expect(s.inference.generation.query(baseAuth.userId, 'missing-id')).rejects.toSatisfy(
      (e: unknown) => isBusinessError(e) && e.code === 'inference.task_not_found',
    );
    s.detach();
  });

  it('上游提交失败走统一分派：可换错误耗尽候选 → upstream_failed；白名单/目录前置拒绝', async () => {
    const s = setup();
    s.upstream.onSubmit(async () => ({ ok: false, error: upstreamError('upstream_error') }));
    await expect(
      s.inference.generation.submit({
        auth: baseAuth,
        kind: 'video',
        body: { model: 'vid-model' },
      }),
    ).rejects.toSatisfy(
      (e: unknown) => isBusinessError(e) && e.code === 'inference.upstream_failed',
    );
    // 白名单拒绝在资金动作之前
    const s2 = setup();
    await expect(
      s2.inference.generation.submit({
        auth: { ...baseAuth, allowedModels: ['other'] },
        kind: 'video',
        body: { model: 'vid-model' },
      }),
    ).rejects.toSatisfy(
      (e: unknown) => isBusinessError(e) && e.code === 'inference.model_not_allowed',
    );
    expect(s2.billing.authorizations).toHaveLength(0);
    await expect(
      s2.inference.generation.submit({ auth: baseAuth, kind: 'video', body: { model: 'nope' } }),
    ).rejects.toSatisfy(
      (e: unknown) => isBusinessError(e) && e.code === 'inference.model_not_found',
    );
    s.detach();
    s2.detach();
  });

  it('上游 4xx 提交失败 → 原码透传（不持久化任务行）', async () => {
    const s = setup();
    s.upstream.onSubmit(async () => ({
      ok: false,
      error: upstreamError('invalid_request', { status: 400, message: 'bad duration' }),
    }));
    const outcome = await s.inference.generation.submit({
      auth: baseAuth,
      kind: 'video',
      body: { model: 'vid-model' },
    });
    expect(outcome).toMatchObject({
      ok: true,
      passthrough: true,
      status: 400,
      code: 'invalid_request',
    });
    s.detach();
  });

  it('P2 回归：task_execute 登记无上游证据——不自愈死凭据/死记忆，只记 sticky', async () => {
    // 登记态只过了健康/预算门，未发生上游调用（worker 事后执行）——
    // 死凭据计数与死记忆计数不得被登记流量清零（旧实现 recordSettleSuccess
    // 会把两者清 0，延缓坏 Key/死模型检测）
    const store = createMemoryHealthStore();
    const upstream = fakeUpstream();
    const billing = fakeBilling();
    const catalog = fakeCatalog(
      {
        'mus-model': mapping({
          mappingId: 22,
          externalModel: 'mus-model',
          realModel: 'mus-real',
          pricingUnit: 'request',
        }),
      },
      { 'mus-real': [channel({ channelId: 2, channelName: 'ch-music' })] },
    );
    const sticky = createMemoryStickyStore();
    const policy = staticRoutingPolicy(
      routingPolicySchema.parse({ scorers: { cacheAffinity: { enabled: true } } }),
    );
    const inference = createInference({
      ai: fakeAi().ai,
      catalog,
      billing: billing.port,
      store,
      policy,
      stickyStore: sticky,
      decrypt: (enc) => enc,
      upstream: upstream.port,
      tasks: createMemoryGenerationTaskStore(),
    });
    // 预涂：死凭据 2/3（未达 invalid）+ 死记忆计数 2/3（未判死）
    inference.health.recordDeadCredential(2, true);
    inference.health.recordDeadCredential(2, true);
    await new Promise((r) => {
      setTimeout(r, 5);
    });
    await store.compareAndSet(
      'dead-model:mus-real',
      0,
      { dead: false, consecutive: 2, lastFailedAt: Date.now(), version: 1 },
      60_000,
    );

    const body = { model: 'mus-model', prompt: 'song', lyrics: '[a]' };
    const outcome = await inference.generation.submit({
      requestId: 'gen-reg',
      auth: baseAuth,
      kind: 'music',
      body,
    });
    expect(outcome.ok).toBe(true);
    await new Promise((r) => {
      setTimeout(r, 5);
    });
    // 登记成功不清零（自愈留给 worker 真实执行结算面）
    await expect(store.getState<DeadCredentialState>('credential:ch:2')).resolves.toMatchObject({
      consecutiveFailures: 2,
    });
    await expect(store.getState<ModelDeadState>('dead-model:mus-real')).resolves.toMatchObject({
      consecutive: 2,
    });
    // cache 亲和粘滞仍记录（偏好面，无证据要求）
    const key = stickyKeyOf(
      { auth: baseAuth, body, externalModel: 'mus-model', endpoint: 'music' },
      policy.latest().scorers.cacheAffinity.prefixChars,
    );
    await expect(sticky.get(key)).resolves.toBe(2);
    inference.close();
  });
});
