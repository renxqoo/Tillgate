/**
 * facade 装配面与残余分支:默认 http 投递器路径、ownerId 缺省、投递器抛错收敛、
 * 未知渠道类型、create 非 23505 错误透传、test 动词空事件表兜底。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNotifications } from '../src/notifications';
import {
  createMemoryNotifyStore,
  createMemoryDb,
  fakeCipher,
  fakeWebhookDeliverer,
  permissiveUrlGuard,
  noopLogger,
  testDispatchConfig,
} from './memory';
import { defined } from './defined';

const enc = (plain: string) => fakeCipher().encrypt(plain);

afterEach(() => vi.unstubAllGlobals());

function facadeWith(overrides: Partial<Parameters<typeof createNotifications>[0]> = {}) {
  const memory = createMemoryNotifyStore();
  const facade = createNotifications({
    db: createMemoryDb(),
    cipher: fakeCipher(),
    urlGuard: permissiveUrlGuard,
    logger: noopLogger,
    webhookAllowLocalUrl: true,
    store: memory.store,
    config: testDispatchConfig,
    ...overrides,
  });
  return { facade, memory };
}

describe('facade 默认装配路径', () => {
  it('未注入 webhookDeliverer 时走默认 http 投递器(stub fetch 全链路:解密→签名→POST)', async () => {
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        fetchCalls.push({ url: String(url), init: init ?? {} });
        return new Response('ok', { status: 200 });
      }),
    );
    const { facade, memory } = facadeWith(); // 不注 deliverer → 默认 http
    memory.seedChannel({
      name: 'wh',
      type: 'webhook',
      config: { url: 'https://hooks.example.test/h', secret: enc('whsec-default') },
      events: ['billing_dead'],
      status: 0,
    });
    memory.seedOutbox({ event: 'billing_dead', payload: { requestId: 'r9' } });
    const result = await facade.dispatchOnce({ ownerId: 'w1' });
    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(fetchCalls).toHaveLength(1);
    const fetchCall = defined(fetchCalls[0], 'fetchCalls[0]');
    expect(fetchCall.url).toBe('https://hooks.example.test/h');
    const headers = fetchCall.init.headers as Record<string, string>;
    expect(headers['x-notify-event']).toBe('billing_dead');
  });

  it('dispatchOnce 不传 ownerId:缺省 per-run 随机(多副本互斥由 DB 认领保证)', async () => {
    const { facade, memory } = facadeWith({ webhookDeliverer: fakeWebhookDeliverer() });
    memory.seedOutbox({ event: 'no_channel_cares' });
    const result = await facade.dispatchOnce();
    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(memory.pendingRows()).toHaveLength(0); // 无订阅终态化
  });

  it('投递器抛错:收敛为失败可重试(不中断本轮)', async () => {
    const throwing = {
      deliver: async () => {
        throw new Error('boom');
      },
    };
    const { facade, memory } = facadeWith({ webhookDeliverer: throwing });
    memory.seedChannel({
      name: 'wh',
      type: 'webhook',
      config: { url: 'https://x.test/h', secret: enc('whsec') },
      events: ['billing_dead'],
      status: 0,
    });
    const id = memory.seedOutbox({ event: 'billing_dead' });
    expect(await facade.dispatchOnce({ ownerId: 'w1' })).toEqual({ sent: 0, failed: 1 });
    expect(defined(memory.outboxRow(id), 'outbox').attempts).toBe(1);
  });

  it('未知渠道类型:投递分支兜底 false → 计失败', async () => {
    const { facade, memory } = facadeWith({ webhookDeliverer: fakeWebhookDeliverer() });
    const channelId = memory.seedChannel({
      name: 'odd',
      type: 'webhook',
      config: { url: 'https://x.test/h', secret: enc('whsec') },
      events: ['billing_dead'],
      status: 0,
    });
    (memory.state.channels.get(channelId) as { type: string }).type = 'sms'; // 词表外类型直改(防御分支)
    const id = memory.seedOutbox({ event: 'billing_dead' });
    expect(await facade.dispatchOnce({ ownerId: 'w1' })).toEqual({ sent: 0, failed: 1 });
    expect(defined(memory.outboxRow(id), 'outbox').attempts).toBe(1);
  });
});

describe('残余分支', () => {
  it('create 非 23505 错误原样透传(不误译)', async () => {
    const memory = createMemoryNotifyStore();
    memory.store.insertChannel = async () => {
      throw new Error('connection reset');
    };
    const { facade } = facadeWith({ store: memory.store });
    await expect(
      facade.channels.create({
        ctx: { requestId: 't', actor: { kind: 'admin', id: 1 } },
        name: 'n',
        type: 'email',
        config: { recipients: ['a@b.test'] },
        events: ['billing_dead'],
      }),
    ).rejects.toThrow('connection reset');
  });

  it('test 动词:空事件表渠道回退 channel_disabled(v1 防御口径)', async () => {
    const { facade, memory } = facadeWith({ webhookDeliverer: fakeWebhookDeliverer() });
    const channelId = memory.seedChannel({
      name: 'empty-events',
      type: 'email',
      config: { recipients: ['a@b.test'] },
      events: [],
      status: 0,
    });
    await facade.channels.test({
      ctx: { requestId: 't', actor: { kind: 'admin', id: 1 } },
      channelId,
    });
    const rows = memory.pendingRows().filter((r) => r.dedupeKey.startsWith(`test:${channelId}:`));
    expect(rows).toHaveLength(1);
    expect(defined(rows[0], 'rows[0]').event).toBe('channel_disabled');
  });
});
