/**
 * 多副本发件箱回归:
 * 同一 outbox 行必须先原子认领再执行外部副作用;部分失败重试不重发已成功渠道。
 * 内存 store 的认领检查与置位之间无 await(原子),配合慢投递放大竞态窗。
 */
import { describe, expect, it } from 'vitest';
import {
  createMemoryNotifyStore,
  createMemoryDb,
  fakeCipher,
  fakeWebhookDeliverer,
  testDispatchConfig,
  noopLogger,
  permissiveUrlGuard,
} from './memory';
import { createNotifications } from '../src/notifications';
import { defined } from './defined';

const enc = (plain: string) => fakeCipher().encrypt(plain);

function concurrencyHarness(opts: { failUrls?: string[]; delayMs?: number } = {}) {
  const memory = createMemoryNotifyStore();
  const deliverer = fakeWebhookDeliverer({ failUrls: opts.failUrls, delayMs: opts.delayMs });
  const facade = createNotifications({
    db: createMemoryDb(),
    cipher: fakeCipher(),
    urlGuard: permissiveUrlGuard,
    logger: noopLogger,
    webhookAllowLocalUrl: true,
    store: memory.store,
    webhookDeliverer: deliverer,
    config: testDispatchConfig,
  });
  return { facade, memory, deliverer };
}

describe('notify_outbox 多 worker 并发', () => {
  it('两个 worker 同时扫描时,同一事件只能产生一次 webhook 副作用', async () => {
    const { facade, memory, deliverer } = concurrencyHarness({ delayMs: 10 });
    memory.seedChannel({
      name: 'probe',
      type: 'webhook',
      config: { url: 'http://127.0.0.1/hook', secret: enc('secret') },
      events: ['concurrency_probe'],
      status: 0,
    });
    memory.seedOutbox({ event: 'concurrency_probe', payload: { requestId: 'same-event' } });

    await Promise.all([
      facade.dispatchOnce({ ownerId: 'worker-a' }),
      facade.dispatchOnce({ ownerId: 'worker-b' }),
    ]);

    expect(deliverer.calls).toHaveLength(1);
  });

  it('多渠道部分失败后只重试失败渠道,不重复发送已成功渠道', async () => {
    const { facade, memory, deliverer } = concurrencyHarness({
      failUrls: ['http://127.0.0.1/flaky'],
    });
    memory.seedChannel({
      name: 'ok',
      type: 'webhook',
      config: { url: 'http://127.0.0.1/ok', secret: enc('secret') },
      events: ['partial_probe'],
      status: 0,
    });
    memory.seedChannel({
      name: 'flaky',
      type: 'webhook',
      config: { url: 'http://127.0.0.1/flaky', secret: enc('secret') },
      events: ['partial_probe'],
      status: 0,
    });
    const id = memory.seedOutbox({ event: 'partial_probe' });

    await facade.dispatchOnce({ ownerId: 'w1' });
    expect(defined(memory.outboxRow(id), 'outbox').deliveredChannelIds).toEqual([1]); // 仅成功渠道进度
    expect(defined(memory.outboxRow(id), 'outbox').sentAt).toBeNull(); // 部分失败 → 待重试

    memory.state.now += 15_001; // 模拟 next_attempt_at 退避到期
    deliverer.behavior.failUrls = []; // flaky 恢复
    const result = await facade.dispatchOnce({ ownerId: 'w2' });

    const callsByUrl = deliverer.calls.reduce<Map<string, number>>((acc, call) => {
      acc.set(call.url, (acc.get(call.url) ?? 0) + 1);
      return acc;
    }, new Map());
    expect(callsByUrl.get('http://127.0.0.1/ok')).toBe(1); // 已成功渠道未重发
    expect(callsByUrl.get('http://127.0.0.1/flaky')).toBe(2); // 失败渠道补投
    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(defined(memory.outboxRow(id), 'outbox').sentAt).not.toBeNull();
  });
});
