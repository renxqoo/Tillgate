/**
 * 契约测试：通知渠道 CRUD/test 五动词 wire 形状与编排透传（ctx actor=admin）、
 * zod 语义（webhook url+secret / email recipients 互斥 refine、events 词表封闭、
 * type 不可改、非法 id 400）+ 凭证回读（200 字节流原样 content-type / 404 词表码）。
 * 业务语义本体在 notifications/control-plane 包测试;此处锁 wire 面。
 */
import { describe, expect, it, vi } from 'vitest';
import { createAdminApp } from '../src/app';
import { ADMIN_ID, authHeader, fakeDeps } from './helpers';

const json = { ...authHeader(), 'content-type': 'application/json' };

const maskedRow = {
  id: 5,
  name: 'ops-webhook',
  type: 'webhook',
  config: { url: 'https://hooks.example/x', secret: '****' },
  events: ['billing_dead'],
  status: 1,
  createdAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:00.000Z',
};

describe('notifications', () => {
  it('列表透传;创建 201 走 facade（ctx actor=admin + 全字段）', async () => {
    const create = vi.fn(async () => maskedRow);
    const app = createAdminApp(
      fakeDeps({
        notifications: {
          list: async () => [maskedRow],
          create,
        },
      }),
    );
    const rows = await app.request('/v1/notifications', { headers: authHeader() });
    expect(rows.status).toBe(200);
    expect(await rows.json()).toEqual([maskedRow]);

    const created = await app.request('/v1/notifications', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        name: 'ops-webhook',
        type: 'webhook',
        config: { url: 'https://hooks.example/x', secret: 's'.repeat(20) },
        events: ['billing_dead'],
      }),
    });
    expect(created.status).toBe(201);
    expect(create).toHaveBeenCalledWith({
      ctx: expect.objectContaining({
        actor: { kind: 'admin', id: ADMIN_ID },
      }),
      name: 'ops-webhook',
      type: 'webhook',
      config: { url: 'https://hooks.example/x', secret: 's'.repeat(20) },
      events: ['billing_dead'],
    });
  });

  it('互斥 refine:webhook 缺 secret / email 缺 recipients / 空 events 一律 400', async () => {
    const create = vi.fn(async () => maskedRow);
    const app = createAdminApp(fakeDeps({ notifications: { create } }));
    for (const bad of [
      {
        name: 'x',
        type: 'webhook',
        config: { url: 'https://h.example/x' },
        events: ['billing_dead'],
      },
      { name: 'x', type: 'email', config: {}, events: ['billing_dead'] },
      {
        name: 'x',
        type: 'webhook',
        config: { url: 'https://h.example/x', secret: 's'.repeat(20) },
        events: [],
      },
      {
        name: 'x',
        type: 'webhook',
        config: { url: 'https://h.example/x', secret: 's'.repeat(20) },
        events: ['not_in_vocab'],
      },
    ]) {
      const res = await app.request('/v1/notifications', {
        method: 'POST',
        headers: json,
        body: JSON.stringify(bad),
      });
      expect(res.status).toBe(400);
      expect(create).not.toHaveBeenCalled();
    }
  });

  it('PATCH 只透传出现键且 type 拒收;DELETE/test 走 facade;非法 id 400', async () => {
    const patch = vi.fn(async () => maskedRow);
    const remove = vi.fn(async () => ({ ok: true as const }));
    const test = vi.fn(async () => ({ ok: true as const }));
    const app = createAdminApp(fakeDeps({ notifications: { patch, remove, test } }));
    const patched = await app.request('/v1/notifications/5', {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ name: 'renamed', status: 0 }),
    });
    expect(patched.status).toBe(200);
    expect(patch).toHaveBeenCalledWith({
      ctx: expect.anything(),
      channelId: 5,
      patch: { name: 'renamed', status: 0 },
    });

    const typeChange = await app.request('/v1/notifications/5', {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ type: 'email' }),
    });
    expect(typeChange.status).toBe(400);

    const removed = await app.request('/v1/notifications/5', {
      method: 'DELETE',
      headers: authHeader(),
    });
    expect(removed.status).toBe(200);
    expect(remove).toHaveBeenCalledWith({ ctx: expect.anything(), channelId: 5 });

    const tested = await app.request('/v1/notifications/5/test', {
      method: 'POST',
      headers: authHeader(),
    });
    expect(tested.status).toBe(200);
    expect(test).toHaveBeenCalledWith({ ctx: expect.anything(), channelId: 5 });

    const badId = await app.request('/v1/notifications/nope/test', {
      method: 'POST',
      headers: authHeader(),
    });
    expect(badId.status).toBe(400);
  });
});

describe('vouchers', () => {
  it('回读:字节流 + 原始 content-type;不存在 404 admin.voucher_not_found', async () => {
    const app = createAdminApp(
      fakeDeps({
        controlPlane: {
          channels: {
            loadVoucher: async (key: string) =>
              key === 'ok-key'
                ? { data: new TextEncoder().encode('PNGDATA'), mimeType: 'image/png' }
                : null,
          },
        },
      }),
    );
    const ok = await app.request('/v1/vouchers/ok-key', { headers: authHeader() });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect(new TextDecoder().decode(await ok.arrayBuffer())).toBe('PNGDATA');

    const missing = await app.request('/v1/vouchers/no-such', { headers: authHeader() });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: 'admin.voucher_not_found' } });
  });
});
