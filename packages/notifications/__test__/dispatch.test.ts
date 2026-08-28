/**
 * 投递循环用例(内存 store 承载 CAS/租约/退避):
 * 终态化/退避/上限/租约过期/fail-closed 链/并行渠道/循环上限。
 */
import { describe, expect, it } from 'vitest';
import {
  buildFacade,
  fakeCipher,
  fakeEmailSender,
  fakeWebhookDeliverer,
  createMemoryNotifyStore,
  createMemoryDb,
  testDispatchConfig,
  noopLogger,
  permissiveUrlGuard,
} from './memory';
import { createNotifications } from '../src/notifications';
import type { MemoryNotifyStore } from './memory';
import { defined } from './defined';

const enc = (plain: string) => fakeCipher().encrypt(plain);

function harness(opts: { failUrls?: string[]; config?: Partial<typeof testDispatchConfig> } = {}) {
  const memory = createMemoryNotifyStore();
  const deliverer = fakeWebhookDeliverer({ failUrls: opts.failUrls });
  const facade = createNotifications({
    db: createMemoryDb(),
    cipher: fakeCipher(),
    urlGuard: permissiveUrlGuard,
    logger: noopLogger,
    webhookAllowLocalUrl: true,
    store: memory.store,
    webhookDeliverer: deliverer,
    config: { ...testDispatchConfig, ...opts.config },
  });
  return { facade, memory, deliverer };
}

describe('无订阅渠道', () => {
  it('事件终态化(sentAt 置位,不再重扫),不产生外部副作用', async () => {
    const { facade, memory, deliverer } = harness();
    memory.seedOutbox({ event: 'parity_probe_unsubscribed', payload: { discrepancies: 1 } });
    const result = await facade.dispatchOnce();
    expect(memory.pendingRows()).toHaveLength(0);
    const row = defined(memory.outboxRow(1), 'outbox');
    expect(row.sentAt).not.toBeNull();
    expect(deliverer.calls).toHaveLength(0);
    expect(result).toEqual({ sent: 0, failed: 0 });
  });

  it('已投递渠道跳过(进度集过滤)', async () => {
    const { facade, memory, deliverer } = harness();
    memory.seedChannel({
      name: 'wh',
      type: 'webhook',
      config: { url: 'https://x.test/h', secret: enc('whsec') },
      events: ['probe_done'],
      status: 0,
    });
    const id = memory.seedOutbox({ event: 'probe_done' });
    defined(memory.outboxRow(id), 'outbox').deliveredChannelIds = [1];
    await facade.dispatchOnce();
    expect(deliverer.calls).toHaveLength(0); // 唯一渠道已成功 → 无目标 → 终态化
    expect(defined(memory.outboxRow(id), 'outbox').sentAt).not.toBeNull();
  });
});

describe('webhook 投递', () => {
  it('成功:调用携带解密明文与 deliveryId,记录进度并终态(sent+1)', async () => {
    const { facade, memory, deliverer } = harness();
    memory.seedChannel({
      name: 'wh',
      type: 'webhook',
      config: { url: 'https://x.test/h', secret: enc('whsec-test') },
      events: ['billing_dead'],
      status: 0,
    });
    const id = memory.seedOutbox({ event: 'billing_dead', payload: { requestId: 'r1' } });
    const result = await facade.dispatchOnce({ ownerId: 'w1' });
    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(deliverer.calls).toHaveLength(1);
    expect(deliverer.calls[0]).toMatchObject({
      url: 'https://x.test/h',
      secret: 'whsec-test', // 解密后的明文进投递
      event: 'billing_dead',
      deliveryId: `${id}:1`,
    });
    const row = defined(memory.outboxRow(id), 'outbox');
    expect(row.sentAt).not.toBeNull();
    expect(row.deliveredChannelIds).toEqual([1]);
  });

  it('失败:attempts+1、lastError、退避推迟、释放认领(failed+1)', async () => {
    const { facade, memory } = harness({ failUrls: ['https://x.test/flaky'] });
    memory.seedChannel({
      name: 'flaky',
      type: 'webhook',
      config: { url: 'https://x.test/flaky', secret: enc('whsec') },
      events: ['billing_dead'],
      status: 0,
    });
    const id = memory.seedOutbox({ event: 'billing_dead' });
    const result = await facade.dispatchOnce({ ownerId: 'w1' });
    expect(result).toEqual({ sent: 0, failed: 1 });
    const row = defined(memory.outboxRow(id), 'outbox');
    expect(row.sentAt).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe('delivery failed');
    expect(row.claimOwner).toBeNull(); // 释放认领
    expect(row.nextAttemptAt).toBe(memory.state.now + 15_000); // 退避 = base × 2^0
    // 退避未到期:再跑一轮不认领
    await facade.dispatchOnce({ ownerId: 'w1' });
    expect(row.attempts).toBe(1);
  });

  it('退避到期重试;达上限(3)终态 failed(sentAt 置位)', async () => {
    const { facade, memory } = harness({ failUrls: ['https://x.test/flaky'] });
    memory.seedChannel({
      name: 'flaky',
      type: 'webhook',
      config: { url: 'https://x.test/flaky', secret: enc('whsec') },
      events: ['billing_dead'],
      status: 0,
    });
    const id = memory.seedOutbox({ event: 'billing_dead' });
    await facade.dispatchOnce({ ownerId: 'w1' }); // attempts 1,退避 15s
    memory.state.now += 15_001;
    await facade.dispatchOnce({ ownerId: 'w2' }); // attempts 2,退避 30s
    expect(defined(memory.outboxRow(id), 'outbox').attempts).toBe(2);
    expect(defined(memory.outboxRow(id), 'outbox').nextAttemptAt).toBe(memory.state.now + 30_000);
    memory.state.now += 30_001;
    const result = await facade.dispatchOnce({ ownerId: 'w3' }); // attempts 3 = 上限 → 终态
    expect(result).toEqual({ sent: 0, failed: 1 });
    const row = defined(memory.outboxRow(id), 'outbox');
    expect(row.sentAt).not.toBeNull(); // 终态不再扫描
    expect(row.attempts).toBe(3);
    memory.state.now += 60_001;
    await facade.dispatchOnce({ ownerId: 'w4' });
    expect(row.attempts).toBe(3); // 终态后不再认领
  });

  it('明文 secret(非 enc:)fail-closed:不调投递即失败', async () => {
    const { facade, memory, deliverer } = harness();
    memory.seedChannel({
      name: 'plain',
      type: 'webhook',
      config: { url: 'https://x.test/h', secret: 'plaintext-secret' },
      events: ['billing_dead'],
      status: 0,
    });
    const id = memory.seedOutbox({ event: 'billing_dead' });
    const result = await facade.dispatchOnce({ ownerId: 'w1' });
    expect(result).toEqual({ sent: 0, failed: 1 });
    expect(deliverer.calls).toHaveLength(0);
    expect(defined(memory.outboxRow(id), 'outbox').attempts).toBe(1);
  });

  it('损坏密文解密抛错 fail-closed', async () => {
    const { facade, memory, deliverer } = harness();
    memory.seedChannel({
      name: 'bad',
      type: 'webhook',
      config: { url: 'https://x.test/h', secret: 'enc:v1:garbage' },
      events: ['billing_dead'],
      status: 0,
    });
    memory.seedOutbox({ event: 'billing_dead' });
    const result = await facade.dispatchOnce({ ownerId: 'w1' });
    expect(result).toEqual({ sent: 0, failed: 1 });
    expect(deliverer.calls).toHaveLength(0);
  });

  it('缺 url fail-closed', async () => {
    const { facade, memory, deliverer } = harness();
    memory.seedChannel({
      name: 'nourl',
      type: 'webhook',
      config: { secret: enc('whsec') },
      events: ['billing_dead'],
      status: 0,
    });
    memory.seedOutbox({ event: 'billing_dead' });
    expect(await facade.dispatchOnce({ ownerId: 'w1' })).toEqual({ sent: 0, failed: 1 });
    expect(deliverer.calls).toHaveLength(0);
  });
});

const seedMail = (memory: MemoryNotifyStore) =>
  memory.seedChannel({
    name: 'mail',
    type: 'email',
    config: { recipients: ['ops@example.test', 'ops2@example.test'] },
    events: ['balance_low'],
    status: 0,
  });

describe('email 投递', () => {
  it('邮件器缺省 fail-closed(投递失败可重试)', async () => {
    const { facade, memory } = harness();
    seedMail(memory);
    memory.seedOutbox({ event: 'balance_low' });
    expect(await facade.dispatchOnce({ ownerId: 'w1' })).toEqual({ sent: 0, failed: 1 });
  });

  it('逐收件人并行发送;subject/text 走模板;成功终态', async () => {
    const mailer = fakeEmailSender();
    const { facade, memory } = buildFacade({ emailSender: mailer });
    seedMail(memory);
    const id = memory.seedOutbox({ event: 'balance_low', payload: { userId: 7, balance: '0.5' } });
    const result = await facade.dispatchOnce({ ownerId: 'w1' });
    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(mailer.sent.map((m) => m.to).toSorted()).toEqual([
      'ops2@example.test',
      'ops@example.test',
    ]);
    for (const mail of mailer.sent) {
      expect(mail.subject).toBe('[AI Gateway] 告警：balance_low');
      expect(mail.text).toContain('"userId": 7');
    }
    expect(defined(memory.outboxRow(id), 'outbox').sentAt).not.toBeNull();
  });

  it('recipients 混入非字符串被过滤;全垃圾则 fail-closed', async () => {
    const mailer = fakeEmailSender();
    const { facade, memory } = buildFacade({ emailSender: mailer });
    memory.seedChannel({
      name: 'mail',
      type: 'email',
      config: { recipients: ['ops@example.test', 42, null] },
      events: ['balance_low'],
      status: 0,
    });
    memory.seedOutbox({ event: 'balance_low' });
    await facade.dispatchOnce({ ownerId: 'w1' });
    expect(mailer.sent.map((m) => m.to)).toEqual(['ops@example.test']); // 非字符串被滤
    const mailer2 = fakeEmailSender();
    const { facade: facade2, memory: memory2 } = buildFacade({ emailSender: mailer2 });
    memory2.seedChannel({
      name: 'mail2',
      type: 'email',
      config: { recipients: [7, false] },
      events: ['balance_low'],
      status: 0,
    });
    memory2.seedOutbox({ event: 'balance_low' });
    expect(await facade2.dispatchOnce({ ownerId: 'w1' })).toEqual({ sent: 0, failed: 1 });
  });
});

describe('租约与循环边界', () => {
  it('租约过期:进度/终态 CAS 零效果,不计数(warn 后跳过;单轮不重领)', async () => {
    const memory = createMemoryNotifyStore();
    const warnings: Array<{ outboxId: number; ownerId: string }> = [];
    const logger = {
      warn: (obj: { outboxId: number; ownerId: string }) => {
        warnings.push(obj);
      },
    };
    const deliverer = fakeWebhookDeliverer({});
    // 投递内拨时钟越过租约 → 后续进度/终态 CAS 全部落空
    deliverer.behavior.delayMs = 0;
    let advanced = false;
    deliverer.deliver = async (input) => {
      if (!advanced) {
        advanced = true;
        memory.state.now += 61_000; // 越过 claimLeaseMs=60s
      }
      return !deliverer.behavior.failUrls.includes(input.url);
    };
    const facade = createNotifications({
      db: createMemoryDb(),
      cipher: fakeCipher(),
      urlGuard: permissiveUrlGuard,
      logger,
      webhookAllowLocalUrl: true,
      store: memory.store,
      webhookDeliverer: deliverer,
      config: { ...testDispatchConfig, loopBatchLimit: 1 }, // 单轮不重领,隔离 CAS 语义
    });
    memory.seedChannel({
      name: 'wh',
      type: 'webhook',
      config: { url: 'https://x.test/h', secret: enc('whsec') },
      events: ['billing_dead'],
      status: 0,
    });
    const id = memory.seedOutbox({ event: 'billing_dead' });
    const result = await facade.dispatchOnce({ ownerId: 'w1' });
    expect(result).toEqual({ sent: 0, failed: 0 }); // 计数零(行待重领)
    expect(warnings).toHaveLength(1); // 过期告警一次
    expect(warnings[0]).toMatchObject({ outboxId: id, ownerId: 'w1' });
    const row = defined(memory.outboxRow(id), 'outbox');
    expect(row.sentAt).toBeNull();
    expect(row.attempts).toBe(0); // 终态 CAS 未生效
    expect(row.deliveredChannelIds).toEqual([]); // 进度 CAS 未生效
    // 租约空闲后可安全重领重投完成(fencing 窗口只到租约边界)
    memory.state.now += 1;
    const again = await createNotifications({
      db: createMemoryDb(),
      cipher: fakeCipher(),
      urlGuard: permissiveUrlGuard,
      logger: noopLogger,
      webhookAllowLocalUrl: true,
      store: memory.store,
      webhookDeliverer: deliverer,
      config: { ...testDispatchConfig, loopBatchLimit: 1 },
    }).dispatchOnce({ ownerId: 'w2' });
    expect(again).toEqual({ sent: 1, failed: 0 });
  });

  it('循环上限:3 行待投,loopBatchLimit=2 只处理 2 行', async () => {
    const { facade, memory, deliverer } = harness({ config: { loopBatchLimit: 2 } });
    memory.seedChannel({
      name: 'wh',
      type: 'webhook',
      config: { url: 'https://x.test/h', secret: enc('whsec') },
      events: ['billing_dead'],
      status: 0,
    });
    for (let i = 0; i < 3; i += 1) memory.seedOutbox({ event: 'billing_dead' });
    const result = await facade.dispatchOnce();
    expect(result).toEqual({ sent: 2, failed: 0 });
    expect(deliverer.calls).toHaveLength(2);
    expect(memory.pendingRows()).toHaveLength(1);
  });

  it('空队列:零副作用直接返回', async () => {
    const { facade, deliverer } = harness();
    expect(await facade.dispatchOnce()).toEqual({ sent: 0, failed: 0 });
    expect(deliverer.calls).toHaveLength(0);
  });
});
