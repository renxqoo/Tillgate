/**
 * 生成任务轮询用例单测（状态机推进/信号顺序不变量/错误分类；
 * 内存任务存储 + 可编程上游/信号/状态替身）。
 */
import { describe, expect, it } from 'vitest';
import { UpstreamError } from '@tillgate/ai';
import { createGenerationPollUseCase } from '../src/application/generation-poll';
import { createMemoryGenerationTaskStore } from '../src/adapters/task-memory';
import type { GenerationTaskRecord, GenerationTaskStore } from '../src/ports/generation';
import type { BillingSignal } from '../src/ports/billing';
import type { ChannelCandidate } from '../src/domain/model/types';
import type { GenerationTaskProbeResult, UpstreamError as UpstreamErrorType } from '@tillgate/ai';
import type { UpstreamTaskExecuteResult } from '../src/ports/upstream';
import type { UsageReceipt } from '../src/domain/usage/receipt';

const CHANNEL: ChannelCandidate = {
  channelId: 7,
  channelName: 'mm',
  providerName: 'minimax',
  protocol: 'minimax',
  vendor: null,
  baseUrl: 'https://up.test',
  apiKeyEnc: 'enc',
  upstreamModel: 'mm-music-v2',
  priority: 1,
  weight: 1,
};

function receiptTemplate(requestId: string): UsageReceipt {
  return {
    requestId,
    userId: 42,
    apiKeyId: null,
    appId: null,
    credentialType: 'key',
    externalModel: 'video-model',
    realModel: 'video-real',
    channelId: 7,
    channelKey: 'mm',
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, estimated: true },
    inputPrice: '0',
    outputPrice: '0',
    cacheInputPrice: '0',
    cacheWritePrice: '0',
    unitPrice: '1.5',
    coefficient: '1',
    durationMs: 0,
    stream: false,
    streamAborted: false,
    mappingId: 3,
    billingPolicyFingerprint: null,
  };
}

function taskOf(input: {
  taskId: string;
  requestId: string;
  kind: 'video' | 'music';
  upstreamTaskId: string | null;
  expiresAt: number;
}): GenerationTaskRecord {
  return {
    taskId: input.taskId,
    requestId: input.requestId,
    userId: 42,
    apiKeyId: null,
    mappingId: 3,
    channelId: 7,
    kind: input.kind,
    upstreamTaskId: input.upstreamTaskId,
    upstreamModel: 'gpt-x-real',
    status: 'queued',
    params: { model: 'video-model', prompt: 'p' },
    receiptTemplate: receiptTemplate(input.requestId),
    unitsSnapshot: 12,
    expiresAt: input.expiresAt,
  };
}

interface Harness {
  tasks: GenerationTaskStore;
  signals: BillingSignal[];
  view: (
    taskId: string,
  ) => Promise<{ status: string; failReason: string | null; result: unknown } | null>;
  errors: Array<{ error: unknown; context: string }>;
  executeCalls: Array<{ upstreamModel: string; externalModel: string }>;
  run: ReturnType<typeof createGenerationPollUseCase>;
  setQuery: (fn: (upstreamTaskId: string) => GenerationTaskProbeResult) => void;
  setExecute: (fn: () => UpstreamTaskExecuteResult) => void;
  setBillingStatus: (fn: (requestId: string) => Promise<string | null>) => void;
  setSignal: (fn: (input: BillingSignal) => Promise<void>) => void;
}

const defaultBillingStatus = async (): Promise<string | null> => 'authorized';
const defaultQuery = (): GenerationTaskProbeResult => ({
  ok: false,
  error: new UpstreamError({ kind: 'network', message: 'unconfigured' }),
});
const defaultExecute = (): UpstreamTaskExecuteResult => ({
  ok: false,
  error: new UpstreamError({ kind: 'network', message: 'unconfigured' }),
});

function harness(options?: { now?: () => number }): Harness {
  const tasks = createMemoryGenerationTaskStore(options?.now);
  const signals: BillingSignal[] = [];
  const errors: Array<{ error: unknown; context: string }> = [];
  let signalImpl: (input: BillingSignal) => Promise<void> = async (input) => {
    signals.push(input);
  };
  let billingStatusImpl: (requestId: string) => Promise<string | null> = defaultBillingStatus;
  let queryImpl: (upstreamTaskId: string) => GenerationTaskProbeResult = defaultQuery;
  let executeImpl: () => UpstreamTaskExecuteResult = defaultExecute;
  const executeCalls: Array<{ upstreamModel: string; externalModel: string }> = [];
  const run = createGenerationPollUseCase({
    tasks,
    upstream: {
      async chat() {
        throw new Error('chat not used by poll');
      },
      async chatStream() {
        throw new Error('stream not used by poll');
      },
      async submitTask() {
        throw new Error('submit not used by poll');
      },
      async queryTask(_channel, upstreamTaskId) {
        return await Promise.resolve(queryImpl(upstreamTaskId));
      },
      async executeTask(_channel, _kind, request) {
        executeCalls.push({
          upstreamModel: request.upstreamModel,
          externalModel: request.externalModel,
        });
        return await Promise.resolve(executeImpl());
      },
    },
    signal: (input) => signalImpl(input),
    billingStatus: (requestId) => billingStatusImpl(requestId),
    findChannel: async (task) => (task.channelId === 7 ? CHANNEL : null),
    config: {
      batch: 10,
      leaseMs: 30_000,
      expireReason: '任务超时（TTL 到期）',
      executeDeadlineMs: 120_000,
      executeMaxRetries: 2,
    },
    onError: (error, context) => {
      errors.push({ error, context });
    },
  });
  return {
    tasks,
    signals,
    errors,
    run,
    executeCalls,
    setQuery: (fn) => {
      queryImpl = fn;
    },
    setExecute: (fn) => {
      executeImpl = fn;
    },
    setBillingStatus: (fn) => {
      billingStatusImpl = fn;
    },
    setSignal: (fn) => {
      signalImpl = fn;
    },
    view: async (taskId) => {
      const view = await tasks.findByOwner(42, taskId);
      return view == null
        ? null
        : { status: view.status, failReason: view.failReason, result: view.result };
    },
  };
}

const FUTURE = Date.now() + 3_600_000;

describe('① 超时扫描', () => {
  it('到期在途任务 → CAS expired + request_failed 释放信号（不扣）', async () => {
    const h = harness();
    await h.tasks.insert(
      taskOf({
        taskId: 't1',
        requestId: 'r1',
        kind: 'video',
        upstreamTaskId: 'up-1',
        expiresAt: Date.now() - 1,
      }),
    );
    const result = await h.run();
    expect(result.expired).toBe(1);
    expect(await h.view('t1')).toMatchObject({
      status: 'expired',
      failReason: '任务超时（TTL 到期）',
    });
    expect(h.signals).toEqual([
      { type: 'request_failed', requestId: 'r1', reason: 'generation_task_expired' },
    ]);
  });
});

describe('② task_poll 族（video）', () => {
  it('running：queued → running 迁移 + lease_renewed（leaseOwner = requestId）', async () => {
    const h = harness();
    await h.tasks.insert(
      taskOf({
        taskId: 't1',
        requestId: 'r1',
        kind: 'video',
        upstreamTaskId: 'up-1',
        expiresAt: FUTURE,
      }),
    );
    h.setQuery(() => ({ ok: true, status: 'running' }));
    const result = await h.run();
    expect(result.polled).toBe(1);
    expect(await h.view('t1')).toMatchObject({ status: 'running' });
    const renew = h.signals.find((s) => s.type === 'lease_renewed');
    expect(renew).toMatchObject({ requestId: 'r1', leaseOwner: 'r1' });
    if (renew?.type === 'lease_renewed') expect(renew.leaseMs).toBeGreaterThanOrEqual(30_000);
  });

  it('succeeded：先信号后终态——收据 units = unitsSnapshot，result 落库', async () => {
    const h = harness();
    await h.tasks.insert(
      taskOf({
        taskId: 't1',
        requestId: 'r1',
        kind: 'video',
        upstreamTaskId: 'up-1',
        expiresAt: FUTURE,
      }),
    );
    h.setQuery(() => ({
      ok: true,
      status: 'succeeded',
      artifact: { url: 'https://cdn.test/v.mp4', width: 720 },
    }));
    const result = await h.run();
    expect(result.succeeded).toBe(1);
    const succeeded = h.signals.find((s) => s.type === 'request_succeeded');
    expect(succeeded).toBeDefined();
    if (succeeded?.type === 'request_succeeded') {
      expect(succeeded.receipt.usage.units).toBe(12);
      expect(succeeded.receipt.unitPrice).toBe('1.5');
    }
    expect(await h.view('t1')).toMatchObject({
      status: 'succeeded',
      result: { url: 'https://cdn.test/v.mp4', width: 720 },
    });
  });

  it('信号失败 → 不终态化（下轮重试信号——宁可晚交付，不可漏收费）', async () => {
    const h = harness();
    await h.tasks.insert(
      taskOf({
        taskId: 't1',
        requestId: 'r1',
        kind: 'video',
        upstreamTaskId: 'up-1',
        expiresAt: FUTURE,
      }),
    );
    h.setQuery(() => ({ ok: true, status: 'succeeded', artifact: { url: 'https://x.test/a' } }));
    h.setSignal(async (input) => {
      if (input.type === 'request_succeeded') throw new Error('billing down');
      h.signals.push(input);
    });
    const result = await h.run();
    expect(result.succeeded).toBe(0);
    expect(await h.view('t1')).toMatchObject({ status: 'queued' });
    expect(h.errors.map((e) => e.context).some((c) => c.includes('settle signal failed'))).toBe(
      true,
    );
  });

  it('自愈路径：billing 已 settlement_pending → 跳过信号直接终态化', async () => {
    const h = harness();
    await h.tasks.insert(
      taskOf({
        taskId: 't1',
        requestId: 'r1',
        kind: 'video',
        upstreamTaskId: 'up-1',
        expiresAt: FUTURE,
      }),
    );
    h.setQuery(() => ({ ok: true, status: 'succeeded', artifact: { url: 'https://x.test/b' } }));
    h.setBillingStatus(async () => 'settlement_pending');
    const result = await h.run();
    expect(result.succeeded).toBe(1);
    expect(h.signals.filter((s) => s.type === 'request_succeeded')).toHaveLength(0);
    expect(await h.view('t1')).toMatchObject({ status: 'succeeded' });
  });

  it('failed：先终态后信号（信号失败仍算 failed——任务已终态，recover 兜底）', async () => {
    const h = harness();
    await h.tasks.insert(
      taskOf({
        taskId: 't1',
        requestId: 'r1',
        kind: 'video',
        upstreamTaskId: 'up-1',
        expiresAt: FUTURE,
      }),
    );
    h.setQuery(() => ({ ok: true, status: 'failed', reason: 'content policy' }));
    h.setSignal(async () => {
      throw new Error('billing down');
    });
    const result = await h.run();
    expect(result.failed).toBe(1);
    expect(await h.view('t1')).toMatchObject({ status: 'failed', failReason: 'content policy' });
    expect(h.errors.map((e) => e.context).some((c) => c.includes('release signal failed'))).toBe(
      true,
    );
  });

  it('上游瞬时错误（!ok）：续租 + 不失败不释放（下轮再查）', async () => {
    const h = harness();
    await h.tasks.insert(
      taskOf({
        taskId: 't1',
        requestId: 'r1',
        kind: 'video',
        upstreamTaskId: 'up-1',
        expiresAt: FUTURE,
      }),
    );
    h.setQuery(() => ({
      ok: false,
      error: new UpstreamError({ kind: 'timeout', message: 'upstream slow' }) as UpstreamErrorType,
    }));
    const result = await h.run();
    expect(result.failed).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(await h.view('t1')).toMatchObject({ status: 'queued' });
    expect(h.signals.filter((s) => s.type === 'lease_renewed')).toHaveLength(1);
  });

  it('渠道缺失：记错跳过（任务保留）', async () => {
    const h = harness();
    // channelId 非 7 → findChannel null
    await h.tasks.insert({
      ...taskOf({
        taskId: 't1',
        requestId: 'r1',
        kind: 'video',
        upstreamTaskId: 'up-1',
        expiresAt: FUTURE,
      }),
      channelId: 999,
    });
    h.setQuery(() => ({ ok: true, status: 'running' }));
    const result = await h.run();
    expect(result.polled).toBe(1);
    expect(
      h.errors.some(
        (e) =>
          e.error instanceof Error &&
          e.error.message === 'channel missing' &&
          e.context.includes('channel=999'),
      ),
    ).toBe(true);
    expect(await h.view('t1')).toMatchObject({ status: 'queued' });
  });
});

describe('③ task_execute 族（music，worker 代执行）', () => {
  it('代执行成功：artifact 结算（先信号后终态）；出站名取任务快照而非渠道实时绑定名', async () => {
    const h = harness();
    await h.tasks.insert(
      taskOf({
        taskId: 't1',
        requestId: 'r1',
        kind: 'music',
        upstreamTaskId: null,
        expiresAt: FUTURE,
      }),
    );
    h.setExecute(() => ({ ok: true, artifact: { audioUrl: 'https://cdn.test/a.mp3' } }));
    const result = await h.run();
    expect(result.executed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(h.signals.filter((s) => s.type === 'request_succeeded')).toHaveLength(1);
    expect(await h.view('t1')).toMatchObject({
      status: 'succeeded',
      result: { audioUrl: 'https://cdn.test/a.mp3' },
    });
    // 渠道候选绑定名是 mm-music-v2（任务登记后的实时值）；代执行用提交时快照 gpt-x-real
    expect(h.executeCalls).toEqual([{ upstreamModel: 'gpt-x-real', externalModel: 'video-model' }]);
  });

  it('代执行失败：CAS failed + request_failed 释放', async () => {
    const h = harness();
    await h.tasks.insert(
      taskOf({
        taskId: 't1',
        requestId: 'r1',
        kind: 'music',
        upstreamTaskId: null,
        expiresAt: FUTURE,
      }),
    );
    h.setExecute(() => ({
      ok: false,
      error: new UpstreamError({ kind: 'upstream_error', message: 'bad request' }),
    }));
    const result = await h.run();
    expect(result.failed).toBe(1);
    expect(h.signals).toContainEqual({
      type: 'request_failed',
      requestId: 'r1',
      reason: 'bad request',
    });
    expect(await h.view('t1')).toMatchObject({ status: 'failed', failReason: 'bad request' });
  });
});

describe('分页与短批', () => {
  it('满批翻页：两页任务全部推进（游标防首屏饥饿）', async () => {
    let seq = 0;
    const now = Date.now();
    const clock = () => now + (seq += 1); // createdAt 严格递增
    const tasks = createMemoryGenerationTaskStore(clock);
    for (let i = 1; i <= 12; i++) {
      await tasks.insert(
        taskOf({
          taskId: `t${i}`,
          requestId: `r${i}`,
          kind: 'video',
          upstreamTaskId: `up-${i}`,
          expiresAt: FUTURE,
        }),
      );
    }
    // 以 batch=5 的窄配置重建用例（harness 默认 batch=10）
    const run = createGenerationPollUseCase({
      tasks,
      upstream: {
        async chat() {
          throw new Error('unused');
        },
        async chatStream() {
          throw new Error('unused');
        },
        async submitTask() {
          throw new Error('unused');
        },
        async queryTask(): Promise<GenerationTaskProbeResult> {
          return { ok: true, status: 'failed', reason: 'done' };
        },
        async executeTask(): Promise<UpstreamTaskExecuteResult> {
          throw new Error('unused');
        },
      },
      signal: async () => {},
      billingStatus: async () => 'authorized',
      findChannel: async () => CHANNEL,
      config: {
        batch: 5,
        leaseMs: 30_000,
        expireReason: 'x',
        executeDeadlineMs: 1_000,
        executeMaxRetries: 0,
      },
      onError: () => {},
    });
    const result = await run();
    expect(result.polled).toBe(12); // 5 + 5 + 2
    expect(result.failed).toBe(12);
  });
});
