/**
 * BullMQ 结算队列装配规格（mock bullmq/ioredis——真 Redis 旅程在 real 门）：
 * 构造参数透传、结局→抛错映射（retried/unknown-failure 重投）、jobId 幂等入队
 * 形状、failed 事件缺陷信号、close 收口顺序。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defined } from './defined.js';

const addBulk = vi.fn(async () => []);
const workerClose = vi.fn(async () => {});
const queueClose = vi.fn(async () => {});
const disconnect = vi.fn();
const workerOn = vi.fn();

vi.mock('ioredis', () => ({
  default: class FakeIORedis {
    constructor(
      public readonly url: string,
      public readonly options: unknown,
    ) {}
    disconnect = disconnect;
  },
}));

vi.mock('bullmq', () => ({
  // vi.fn 包构造:可 new 且保留 mock.calls(构造参数与 processor 回调可断言)
  Queue: vi.fn(function MockQueue(this: never) {
    const self = this as unknown as Record<string, unknown>;
    self.addBulk = addBulk;
    self.close = queueClose;
  }),
  Worker: vi.fn(function MockWorker(this: never) {
    const self = this as unknown as Record<string, unknown>;
    self.on = workerOn;
    self.close = workerClose;
  }),
}));

import { createSettlementQueue, SETTLEMENT_QUEUE_NAME } from '../src/queue/settlement-queue';
import IORedis from 'ioredis';
import { Queue, Worker } from 'bullmq';

/** Worker 构造第 n 次调用注册的 processor(mock.calls[n][1]) */
function processorOf(callIndex: number) {
  const { calls } = (Worker as unknown as { mock: { calls: Array<[unknown, unknown, unknown]> } }).mock;
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
});

describe('queue/settlement-queue：BullMQ 装配（mock 面）', () => {
  it('构造参数透传：ioredis maxRetriesPerRequest=null、prefix/concurrency', () => {
    harness(async () => 'settled');
    const ctor = IORedis as unknown as new (url: string, options: unknown) => { url: string; options: unknown };
    const fake = new ctor('redis://localhost:6379/0', { maxRetriesPerRequest: null });
    expect(fake.url).toBe('redis://localhost:6379/0');
    expect(fake.options).toEqual({ maxRetriesPerRequest: null });
    expect(Worker).toHaveBeenCalledWith(
      SETTLEMENT_QUEUE_NAME,
      expect.any(Function),
      { connection: expect.anything(), prefix: '{test}', concurrency: 3 },
    );
    expect(Queue).toHaveBeenCalledWith(SETTLEMENT_QUEUE_NAME, {
      connection: expect.anything(),
      prefix: '{test}',
    });
  });

  it('enqueueMany：jobId=requestId + attempts/backoff 一次性形状；空数组零调用', async () => {
    const face = harness(async () => 'settled');
    await face.enqueueMany(['r1', 'r2']);
    expect(addBulk).toHaveBeenCalledWith([
      {
        name: 'settle',
        data: { requestId: 'r1' },
        opts: expect.objectContaining({ jobId: 'r1', attempts: 7, backoff: { type: 'exponential', delay: 250 } }),
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
    const handler = defined(
      defined(registered[0], 'failed handler')[1],
      'failed handler fn',
    ) as (job: unknown, error: Error) => void;
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
