/**
 * BullMQ 结算队列装配规格（mock bullmq/ioredis——真 Redis 旅程在 real 门）：
 * 构造参数透传、结局→抛错映射（retried/unknown-failure 重投）、jobId 幂等入队
 * 形状、终态残留 remove+重投出口、failed 事件缺陷信号、close 收口顺序。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defined } from './defined.js';

const addBulk = vi.fn(async () => []);
const workerClose = vi.fn(async () => {});
const queueClose = vi.fn(async () => {});
const disconnect = vi.fn();
const ping = vi.fn(async () => 'PONG');
const redisCtorArgs: unknown[][] = [];
const workerOn = vi.fn();
/**
 * jobId → getJob 返回形状：state 'missing'=getJob 返回 null；无登记=缺省活 job
 * (waiting)。finishedOn 模拟完结时间(终态残留=早于入队;竞态完结=晚于入队)。
 */
const jobStates = new Map<string, { state: string; finishedOn?: number }>();
const queueRemove = vi.fn(async () => {});
const queueAdd = vi.fn(async () => ({}));

vi.mock('ioredis', () => ({
  default: class FakeIORedis {
    constructor(...args: unknown[]) {
      redisCtorArgs.push(args);
    }
    disconnect = disconnect;
    ping = ping;
  },
}));

vi.mock('bullmq', () => ({
  // vi.fn 包构造:可 new 且保留 mock.calls(构造参数与 processor 回调可断言)
  Queue: vi.fn(function MockQueue(this: never) {
    const self = this as unknown as Record<string, unknown>;
    self.addBulk = addBulk;
    self.close = queueClose;
    self.getJob = async (id: string) => {
      const spec = jobStates.get(id);
      if (spec == null) return { getState: async () => 'waiting' };
      if (spec.state === 'missing') return null;
      return { getState: async () => spec.state, finishedOn: spec.finishedOn };
    };
    self.remove = queueRemove;
    self.add = queueAdd;
  }),
  Worker: vi.fn(function MockWorker(this: never) {
    const self = this as unknown as Record<string, unknown>;
    self.on = workerOn;
    self.close = workerClose;
  }),
}));

import { createSettlementQueue, SETTLEMENT_QUEUE_NAME } from '../src/queue/settlement-queue';
import { Queue, Worker } from 'bullmq';

/** Worker 构造第 n 次调用注册的 processor(mock.calls[n][1]) */
function processorOf(callIndex: number) {
  const { calls } = (Worker as unknown as { mock: { calls: Array<[unknown, unknown, unknown]> } })
    .mock;
  const [, registered] = defined(calls[callIndex], `worker ctor call #${callIndex}`);
  return registered as (job: { data: { requestId: string } }) => Promise<void>;
}

function harness(process: (id: string) => Promise<string>) {
  return createSettlementQueue({
    redisUrl: 'redis://localhost:6379/0',
    prefix: '{test}',
    concurrency: 3,
    maxAttempts: 7,
    backoffBaseMs: 250,
    process: process as never,
    logger: { info: () => {}, error: () => {} },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  jobStates.clear();
  redisCtorArgs.length = 0;
  ping.mockResolvedValue('PONG');
});

describe('queue/settlement-queue：BullMQ 装配（mock 面）', () => {
  it('构造参数透传：ioredis maxRetriesPerRequest=null、prefix/concurrency', () => {
    harness(async () => 'settled');
    expect(redisCtorArgs).toEqual([
      ['redis://localhost:6379/0', { maxRetriesPerRequest: null, enableOfflineQueue: true }],
    ]);
    expect(Worker).toHaveBeenCalledWith(SETTLEMENT_QUEUE_NAME, expect.any(Function), {
      connection: expect.anything(),
      prefix: '{test}',
      concurrency: 3,
    });
    expect(Queue).toHaveBeenCalledWith(SETTLEMENT_QUEUE_NAME, {
      connection: expect.anything(),
      prefix: '{test}',
    });
  });

  it('Sentinel 构造参数携 master/双密码/db，不再直连 redis 服务名', () => {
    createSettlementQueue({
      redisUrl: 'redis://:data-pass@redis:6379/4',
      sentinels: 's1:26379,s2:26379',
      sentinelName: 'mymaster',
      sentinelPassword: 'sentinel-pass',
      prefix: '{test}',
      concurrency: 1,
      maxAttempts: 3,
      backoffBaseMs: 100,
      process: async () => 'settled',
      logger: { info: () => {}, error: () => {} },
    });
    expect(redisCtorArgs).toEqual([
      [
        expect.objectContaining({
          sentinels: [
            { host: 's1', port: 26379 },
            { host: 's2', port: 26379 },
          ],
          name: 'mymaster',
          password: 'data-pass',
          db: 4,
          sentinelPassword: 'sentinel-pass',
          maxRetriesPerRequest: null,
          enableOfflineQueue: true,
        }),
      ],
    ]);
  });

  it('ping 是 BullMQ Redis readiness 真实出口', async () => {
    const face = harness(async () => 'settled');
    await expect(face.ping()).resolves.toBeUndefined();
    ping.mockRejectedValueOnce(new Error('redis down'));
    await expect(face.ping()).rejects.toThrow(/redis down/);
  });

  it('enqueueMany：jobId=requestId + attempts/backoff 一次性形状；空数组零调用', async () => {
    const face = harness(async () => 'settled');
    await face.enqueueMany(['r1', 'r2']);
    expect(addBulk).toHaveBeenCalledWith([
      {
        name: 'settle',
        data: { requestId: 'r1' },
        opts: expect.objectContaining({
          jobId: 'r1',
          attempts: 7,
          backoff: { type: 'exponential', delay: 250 },
        }),
      },
      {
        name: 'settle',
        data: { requestId: 'r2' },
        opts: expect.objectContaining({ jobId: 'r2' }),
      },
    ]);
    await face.enqueueMany([]);
    expect(addBulk).toHaveBeenCalledTimes(1);
  });

  it('enqueueMany 终态残留出口：completed/failed 旧 job → remove+重投；活 job/缺 job/竞态完结不动', async () => {
    jobStates.set('r-done', { state: 'completed', finishedOn: Date.now() - 60_000 });
    jobStates.set('r-failed', { state: 'failed', finishedOn: Date.now() - 60_000 });
    jobStates.set('r-gone', { state: 'missing' });
    // 竞态完结:finishedOn 晚于本批入队时刻 → 不算残留
    jobStates.set('r-race', { state: 'completed', finishedOn: Date.now() + 5_000 });
    const face = harness(async () => 'settled');
    await face.enqueueMany(['r-live', 'r-done', 'r-failed', 'r-gone', 'r-race']);
    expect(queueRemove).toHaveBeenCalledTimes(2);
    expect(queueRemove).toHaveBeenCalledWith('r-done');
    expect(queueRemove).toHaveBeenCalledWith('r-failed');
    expect(queueRemove).not.toHaveBeenCalledWith('r-live');
    expect(queueRemove).not.toHaveBeenCalledWith('r-gone');
    expect(queueRemove).not.toHaveBeenCalledWith('r-race');
    expect(queueAdd).toHaveBeenCalledTimes(2);
    for (const id of ['r-done', 'r-failed']) {
      expect(queueAdd).toHaveBeenCalledWith(
        'settle',
        { requestId: id },
        expect.objectContaining({
          jobId: id,
          attempts: 7,
          backoff: { type: 'exponential', delay: 250 },
        }),
      );
    }
  });

  /** Worker 构造第 n 次调用注册的 processor(mock.calls[n][1];describe 外单一定义) */

  it('消费端结局映射：终态结局不抛；retried/unknown-failure 抛错交 BullMQ 重投', async () => {
    harness(async () => 'settled');
    await expect(processorOf(0)({ data: { requestId: 'r1' } })).resolves.toBeUndefined();
    harness(async () => 'retried');
    await expect(processorOf(1)({ data: { requestId: 'r1' } })).rejects.toThrow(/retried/);
    harness(async () => 'unknown-failure');
    await expect(processorOf(2)({ data: { requestId: 'r1' } })).rejects.toThrow(/unknown-failure/);
  });

  it('failed 事件 → error 日志（缺陷信号）', () => {
    const errors: unknown[] = [];
    createSettlementQueue({
      redisUrl: 'redis://localhost:6379/0',
      prefix: '{test}',
      concurrency: 1,
      maxAttempts: 3,
      backoffBaseMs: 100,
      process: async () => 'settled',
      logger: { info: () => {}, error: (obj) => void errors.push(obj) },
    });
    const registered = workerOn.mock.calls.filter(([event]) => event === 'failed');
    expect(registered).toHaveLength(1);
    const handler = defined(defined(registered[0], 'failed handler')[1], 'failed handler fn') as (
      job: unknown,
      error: Error,
    ) => void;
    handler({ id: 'job-1', attemptsMade: 3 }, new Error('exhausted'));
    expect(errors).toHaveLength(1);
  });

  it('close 收口顺序：worker.close → queue.close → connection.disconnect', async () => {
    const order: string[] = [];
    workerClose.mockImplementationOnce(async () => {
      order.push('worker');
    });
    queueClose.mockImplementationOnce(async () => {
      order.push('queue');
    });
    disconnect.mockImplementationOnce(() => {
      order.push('disconnect');
    });
    const face = harness(async () => 'settled');
    await face.close();
    expect(order).toEqual(['worker', 'queue', 'disconnect']);
  });
});
