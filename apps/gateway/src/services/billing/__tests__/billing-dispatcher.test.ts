import { describe, expect, it } from 'vitest';
import { createBillingDispatcherFromQueue } from '../billing-dispatcher.js';

function dispatcher(
  queueAdd: (name: string, data: unknown, options: unknown) => Promise<unknown>,
) {
  return createBillingDispatcherFromQueue({
    add: queueAdd,
    close: () => Promise.resolve(),
  });
}

describe('BillingDispatcher', () => {
  it('队列只携带 requestId，不携带 usage/价格/用户事实', async () => {
    let data: unknown;
    const value = dispatcher(async (_name, payload) => {
      data = payload;
      return {};
    });
    expect((await value.wake('req-1')).ok).toBe(true);
    expect(data).toEqual({ requestId: 'req-1' });
  });

  it('入队失败返回错误，由 DB sweeper 恢复', async () => {
    const value = dispatcher(async () => {
      throw new Error('redis unavailable');
    });
    await expect(value.wake('req-2')).resolves.toMatchObject({ ok: false });
  });

  it('失败任务保留，便于观测与人工排障', async () => {
    let options: unknown;
    const value = dispatcher(async (_name, _data, config) => {
      options = config;
      return {};
    });
    await value.wake('req-3');
    expect(options).toMatchObject({ removeOnFail: false, attempts: 3 });
  });
});
