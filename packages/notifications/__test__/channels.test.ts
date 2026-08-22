/**
 * 渠道管理用例(v1 admin ops/ops-coverage 通知段的行为规格,facade 断言):
 * 创建(校验/加密/掩码/重名)、更新(status/events/config/miss)、删除、测试入箱、列表掩码。
 */
import { describe, expect, it } from 'vitest';
import { notificationsErrors } from '../src/errors';
import { buildFacade } from './memory';
import type { NotifyContext } from '../src/application/context';

const ctx: NotifyContext = { requestId: 't-channels', actor: { kind: 'admin', id: 1 } };

const webhookInput = {
  name: 'notify-main',
  type: 'webhook' as const,
  config: { url: 'https://hooks.example.test/x', secret: 's'.repeat(24) },
  events: ['channel_disabled', 'billing_dead'],
};

describe('创建渠道', () => {
  it('email 缺 recipients → invalid_channel_input', async () => {
    const { facade } = buildFacade();
    const err = await facade.channels
      .create({ ctx, name: 'ch', type: 'email', config: {}, events: ['billing_dead'] })
      .catch((e: unknown) => e);
    expect(notificationsErrors.has((err as { code: string }).code)).toBe(true);
    expect((err as { code: string }).code).toBe('notifications.invalid_channel_input');
  });

  it('webhook 创建:落库密文、返回掩码(密文不回显)', async () => {
    const { facade, memory } = buildFacade();
    const row = await facade.channels.create({ ctx, ...webhookInput });
    expect(row.id).toBeGreaterThan(0);
    expect(row.config.secret).toMatch(/^\*{4}/); // ****+尾4(密文尾)
    const stored = memory.state.channels.get(row.id)!;
    expect(stored.config.secret).toMatch(/^enc:v1:fake:/); // 落库是密文
    expect(stored.config.secret).not.toBe(webhookInput.config.secret);
  });

  it('重名 → channel_exists(唯一索引兜底翻译)', async () => {
    const { facade } = buildFacade();
    await facade.channels.create({ ctx, ...webhookInput });
    const err = await facade.channels
      .create({
        ctx,
        ...webhookInput,
        config: { url: 'https://hooks.example.test/y', secret: 's'.repeat(24) },
      })
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('notifications.channel_exists');
  });

  it('未知事件 → invalid_input(词表门)', async () => {
    const { facade } = buildFacade();
    const err = await facade.channels
      .create({
        ctx,
        name: 'ch',
        type: 'email',
        config: { recipients: ['a@b.test'] },
        events: ['not_an_event'],
      })
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('notifications.invalid_channel_input');
  });
});

describe('更新渠道', () => {
  it('PATCH status 生效并回显', async () => {
    const { facade } = buildFacade();
    const created = await facade.channels.create({ ctx, ...webhookInput });
    const patched = await facade.channels.patch({
      ctx,
      channelId: created.id,
      patch: { status: 1 },
    });
    expect(patched.status).toBe(1);
  });

  it('PATCH events + config:整体替换并重加密、返回掩码', async () => {
    const { facade, memory } = buildFacade();
    const created = await facade.channels.create({ ctx, ...webhookInput });
    const patched = await facade.channels.patch({
      ctx,
      channelId: created.id,
      patch: {
        events: ['billing_dead'],
        config: { url: 'https://hooks.example.test/z', secret: 'n'.repeat(24) },
      },
    });
    expect(patched.events).toEqual(['billing_dead']);
    expect(patched.config.secret).toMatch(/^\*{4}/);
    const stored = memory.state.channels.get(created.id)!;
    expect(stored.config.secret).toMatch(/^enc:v1:fake:/);
    expect(stored.config.url).toBe('https://hooks.example.test/z');
  });

  it('patch miss → channel_not_found', async () => {
    const { facade } = buildFacade();
    const err = await facade.channels
      .patch({ ctx, channelId: 999, patch: { status: 1 } })
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('notifications.channel_not_found');
  });

  it('非法 patch(空事件表)→ invalid_input', async () => {
    const { facade } = buildFacade();
    const err = await facade.channels
      .patch({ ctx, channelId: 1, patch: { events: [] } })
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('notifications.invalid_channel_input');
  });
});

describe('删除渠道', () => {
  it('miss → not_found;命中删除后不可再查', async () => {
    const { facade, memory } = buildFacade();
    const err = await facade.channels.remove({ ctx, channelId: 999 }).catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('notifications.channel_not_found');
    const created = await facade.channels.create({ ctx, ...webhookInput });
    await facade.channels.remove({ ctx, channelId: created.id });
    expect(memory.state.channels.has(created.id)).toBe(false);
  });
});

describe('测试事件入箱', () => {
  it('入箱首订阅事件 + {test:true, channel:name};dedupeKey test:{id}:{ts}', async () => {
    const { facade, memory } = buildFacade();
    const created = await facade.channels.create({ ctx, ...webhookInput });
    await facade.channels.test({ ctx, channelId: created.id });
    const rows = memory.pendingRows().filter((r) => r.dedupeKey.startsWith(`test:${created.id}:`));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event).toBe('channel_disabled'); // 首订阅事件
    expect(rows[0]!.payload).toEqual({ test: true, channel: 'notify-main' });
  });

  it('miss → not_found', async () => {
    const { facade } = buildFacade();
    const err = await facade.channels.test({ ctx, channelId: 999 }).catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('notifications.channel_not_found');
  });
});

describe('列表', () => {
  it('全量回显且 secret 恒掩码(密文不出包)', async () => {
    const { facade } = buildFacade();
    await facade.channels.create({ ctx, ...webhookInput });
    await facade.channels.create({
      ctx,
      name: 'mail-ops',
      type: 'email',
      config: { recipients: ['ops@example.test'] },
      events: ['balance_low'],
    });
    const list = await facade.channels.list();
    expect(list).toHaveLength(2);
    expect(list.map((c) => c.name).toSorted()).toEqual(['mail-ops', 'notify-main']);
    for (const row of list) {
      if (typeof row.config.secret === 'string') expect(row.config.secret).toMatch(/^\*{4}/);
    }
  });
});
