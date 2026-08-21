/**
 * 多副本发件箱回归：同一 outbox 行必须先原子认领，再执行外部副作用。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db, NotificationRepository } from '@ai-gateway/repository';
import { encrypt } from '@ai-gateway/core';
import { runNotifyDispatchOnce } from '../tasks/notify-dispatch.js';

describe('notify_outbox 多 worker 并发', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('两个 worker 同时扫描时，同一事件只能产生一次 webhook 副作用', async () => {
    const encryptionKey = 'concurrency-notify-key-32-characters';
    const item = {
      id: 1,
      event: 'concurrency_probe',
      payload: { requestId: 'same-event' },
      attempts: 0,
      claimToken: '00000000-0000-4000-8000-000000000001',
      deliveredChannelIds: [],
    };
    const channel = {
      id: 1,
      name: 'probe',
      type: 'webhook',
      config: { url: 'http://127.0.0.1/hook', secret: encrypt('secret', encryptionKey) },
      events: ['concurrency_probe'],
      status: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // fake repo 模拟数据库的原子 claim：并发调用只有一个能取得同一行。
    let claimed = false;
    const repository = {
      listActive: async () => [channel],
      claimPending: async () => {
        if (claimed) return [];
        claimed = true;
        return [item];
      },
      completeClaim: async () => true,
      failClaim: async () => true,
      recordDeliveredChannels: async () => true,
    } as unknown as NotificationRepository;
    const db = {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    } as unknown as Db;

    let webhookCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        webhookCalls += 1;
        // 放大 SELECT 与终态 UPDATE 之间的竞态窗。
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        return new Response('ok', { status: 200 });
      }),
    );

    const logger = { warn: () => undefined };
    await Promise.all([
      runNotifyDispatchOnce(db, logger, undefined, { webhookAllowLocalUrl: true, encryptionKey, repository }),
      runNotifyDispatchOnce(db, logger, undefined, { webhookAllowLocalUrl: true, encryptionKey, repository }),
    ]);

    expect(webhookCalls).toBe(1);
  });

  it('多渠道部分失败后只重试失败渠道，不重复发送已成功渠道', async () => {
    const encryptionKey = 'partial-retry-notify-key-32-characters';
    const deliveredChannelIds: number[] = [];
    let claimable = true;
    let completed = false;
    const item = {
      id: 9,
      event: 'partial_probe',
      payload: { requestId: 'partial-event' },
      attempts: 0,
      claimToken: '00000000-0000-4000-8000-000000000009',
      deliveredChannelIds,
    };
    const channels = [
      { id: 11, name: 'ok', type: 'webhook', config: { url: 'http://127.0.0.1/ok', secret: encrypt('secret', encryptionKey) }, events: ['partial_probe'], status: 0, createdAt: new Date(), updatedAt: new Date() },
      { id: 12, name: 'flaky', type: 'webhook', config: { url: 'http://127.0.0.1/flaky', secret: encrypt('secret', encryptionKey) }, events: ['partial_probe'], status: 0, createdAt: new Date(), updatedAt: new Date() },
    ];
    const repository = {
      listActive: async () => channels,
      claimPending: async () => {
        if (!claimable || completed) return [];
        claimable = false;
        return [{ ...item, deliveredChannelIds: [...deliveredChannelIds] }];
      },
      recordDeliveredChannels: async (_c: unknown, input: { channelIds: number[] }) => {
        for (const id of input.channelIds) if (!deliveredChannelIds.includes(id)) deliveredChannelIds.push(id);
        return true;
      },
      completeClaim: async () => {
        completed = true;
        return true;
      },
      failClaim: async () => true,
    } as unknown as NotificationRepository;
    const db = { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db) } as unknown as Db;

    const calls = new Map<string, number>();
    let flakyHealthy = false;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.set(url, (calls.get(url) ?? 0) + 1);
      return new Response('', { status: url.endsWith('/flaky') && !flakyHealthy ? 503 : 200 });
    }));

    await runNotifyDispatchOnce(db, { warn: () => undefined }, undefined, {
      webhookAllowLocalUrl: true,
      encryptionKey,
      repository,
    });
    expect(deliveredChannelIds).toEqual([11]);
    flakyHealthy = true;
    claimable = true; // 模拟 next_attempt_at 退避到期
    await runNotifyDispatchOnce(db, { warn: () => undefined }, undefined, {
      webhookAllowLocalUrl: true,
      encryptionKey,
      repository,
    });

    expect(calls.get('http://127.0.0.1/ok')).toBe(1);
    expect(calls.get('http://127.0.0.1/flaky')).toBe(2);
    expect(completed).toBe(true);
  });
});
