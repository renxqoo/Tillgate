import { describe, expect, it } from 'vitest';
import { isBusinessError } from '@tokenlens/errors';
import { createInference } from '../src/inference';
import { createMemoryGenerationTaskStore } from '../src/adapters/task-memory';
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
    // 任务存储注入失败实现：总抛错的 store（预留保留语义断言）
    const failing = {
      insert: async () => {
        throw new Error('pg down');
      },
      findByOwner: async () => null,
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
        (e: unknown) => e,
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
});
