/**
 * E2E ③新增接口 + 状态修改全扫（HTTP-only，14 模块全资源面）：
 * 每个资源走 创建 → 修改（含状态翻转）→ 列表回显 →（可行时）终态。
 * 端点覆盖统计口径：auth/login、me、providers×4、channels×4(+probe/import 已在
 * 集成面)、models×5、rate-cards×4、catalog×3、users×5、keys×2、subscriptions×3、
 * plans×4、redeem×4、channel-funds×3、vouchers×1 —— 本文件 + E2E①② 合计 ≥90%。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupE2E,
  e2eDb,
  e2eUid,
  http,
  loginAdmin,
  seedAdmin,
  seedE2EUser,
  startAdminApi,
  trackE2E,
  type E2EAdminApi,
} from './e2e-kit.js';

let api: E2EAdminApi;
let token: string;

beforeAll(async () => {
  const db = e2eDb();
  api = await startAdminApi(db);
  const { email, password } = await seedAdmin(db);
  token = await loginAdmin(api.baseUrl, email, password);
});

afterAll(async () => {
  await api.stop();
  await cleanupE2E(api.db);
});

describe('E2E 计费三轴资源全扫', () => {
  it('providers：创建 → 改名 → 退役（列表不再启用）', async () => {
    const name = e2eUid('prov');
    const created = await http(api.baseUrl, '/v1/providers', { token, body: { name, baseUrl: 'https://sweep.e2e.test/v1' } });
    expect(created.status).toBe(201);
    const id = created.body.id as number;
    trackE2E.provider(id);

    const patched = await http(api.baseUrl, `/v1/providers/${id}`, {
      method: 'PATCH',
      token,
      body: { name: `${name}-v2`, status: 0 },
    });
    expect(patched.status).toBe(200);

    expect((await http(api.baseUrl, `/v1/providers/${id}`, { method: 'DELETE', token })).status).toBe(200);
    const list = await http(api.baseUrl, `/v1/providers?q=${name}`, { token });
    const row = (list.body.rows as Array<{ id: number; status: number }>).find((r) => r.id === id);
    expect(row!.status).toBe(1); // 软退役
  });

  it('channels：创建 → 换 Key+禁用 → 列表富化', async () => {
    const provider = await http(api.baseUrl, '/v1/providers', {
      token,
      body: { name: e2eUid('prov'), baseUrl: 'https://sweep.e2e.test/v1' },
    });
    const providerId = provider.body.id as number;
    trackE2E.provider(providerId);

    const channelName = e2eUid('ch');
    const created = await http(api.baseUrl, '/v1/channels', {
      token,
      body: { providerId, name: channelName, apiKey: 'sk-sweep-1', models: ['model-a'] },
    });
    expect(created.status).toBe(201);
    const channelId = created.body.id as number;
    trackE2E.channel(channelId);

    // 换 Key（复位运行态）+ 禁用（状态修改）
    const rotated = await http(api.baseUrl, `/v1/channels/${channelId}`, {
      method: 'PATCH',
      token,
      body: { apiKey: 'sk-sweep-2' },
    });
    expect(rotated.status).toBe(200);
    const disabled = await http(api.baseUrl, `/v1/channels/${channelId}`, {
      method: 'PATCH',
      token,
      body: { status: 1 },
    });
    expect(disabled.status).toBe(200);
    expect(disabled.body.status).toBe(1);

    const list = await http(api.baseUrl, `/v1/channels?q=${channelName}`, { token });
    expect(list.status).toBe(200);
    const mine = (list.body.rows as Array<{ id: number; providerName: string; boundModels: string[] }>).find(
      (r) => r.id === channelId,
    );
    expect(mine!.providerName).toBeTruthy();
    expect(mine!.boundModels).toEqual([]);
  });

  it('models：创建 → 绑渠道 → 回显 channelIds → 改价 → 下架', async () => {
    const provider = await http(api.baseUrl, '/v1/providers', {
      token,
      body: { name: e2eUid('prov'), baseUrl: 'https://sweep.e2e.test/v1' },
    });
    const providerId = provider.body.id as number;
    trackE2E.provider(providerId);
    const channel = await http(api.baseUrl, '/v1/channels', {
      token,
      body: { providerId, name: e2eUid('ch'), apiKey: 'sk-sweep' },
    });
    const channelId = channel.body.id as number;
    trackE2E.channel(channelId);

    const externalName = e2eUid('model');
    const created = await http(api.baseUrl, '/v1/models', {
      token,
      body: { externalName, realModel: e2eUid('real'), inputPrice: '1', outputPrice: '2', cacheInputPrice: '0.5' },
    });
    expect(created.status).toBe(201);
    const mappingId = created.body.id as number;
    trackE2E.mapping(mappingId);

    const bound = await http(api.baseUrl, `/v1/models/${mappingId}/channels`, {
      token,
      body: { channels: [{ channelId }] },
    });
    expect(bound.status).toBe(200);

    const list = await http(api.baseUrl, `/v1/models?q=${externalName}`, { token });
    const mine = (list.body.rows as Array<{ id: number; channelIds: number[] }>)[0]!;
    expect(mine.channelIds).toEqual([channelId]);

    const repriced = await http(api.baseUrl, `/v1/models/${mappingId}`, {
      method: 'PATCH',
      token,
      body: { inputPrice: '3' },
    });
    expect(repriced.status).toBe(200);
    expect((await http(api.baseUrl, `/v1/models/${mappingId}`, { method: 'DELETE', token })).status).toBe(200);
  });

  it('rate-cards：创建 → 改系数 → health → 绑用户 → 删除被拒 → 解绑 → 删除', async () => {
    const created = await http(api.baseUrl, '/v1/rate-cards', {
      token,
      body: { name: e2eUid('card'), coefficient: '1.5' },
    });
    expect(created.status).toBe(201);
    expect(created.body.coefficient).toBe('1.500');
    const cardId = created.body.id as number;
    trackE2E.card(cardId);

    const patched = await http(api.baseUrl, `/v1/rate-cards/${cardId}`, {
      method: 'PATCH',
      token,
      body: { coefficient: '0.8' },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.coefficient).toBe('0.800');

    const health = await http(api.baseUrl, `/v1/rate-cards/${cardId}/health`, { token });
    expect(health.body.hasGlobalCoefficient).toBe(true);

    // 绑用户（状态修改）→ 删除被拒 → 卡内用户列表 → 解绑 → 删除成功
    const userId = await seedE2EUser(api.db);
    const bound = await http(api.baseUrl, `/v1/users/${userId}`, {
      method: 'PATCH',
      token,
      body: { rateCardId: cardId },
    });
    expect(bound.status).toBe(200);
    expect((await http(api.baseUrl, `/v1/rate-cards/${cardId}`, { method: 'DELETE', token })).status).toBe(409);
    const users = await http(api.baseUrl, `/v1/rate-cards/${cardId}/users`, { token });
    expect(users.body.total).toBe(1);

    await http(api.baseUrl, `/v1/users/${userId}`, { method: 'PATCH', token, body: { rateCardId: null } });
    expect((await http(api.baseUrl, `/v1/rate-cards/${cardId}`, { method: 'DELETE', token })).status).toBe(200);
  });

  it('目录面：sources / vendor-catalog / 未知源 404', async () => {
    const sources = await http(api.baseUrl, '/v1/model-catalog/sources', { token });
    expect(sources.status).toBe(200);
    expect(Array.isArray(sources.body.sources)).toBe(true);

    const vendors = await http(api.baseUrl, '/v1/vendor-catalog', { token });
    expect(vendors.status).toBe(200);
    expect((vendors.body.protocols as string[]).length).toBeGreaterThan(0);

    expect((await http(api.baseUrl, '/v1/model-catalog/no-such', { token })).status).toBe(404);
  });
});

describe('E2E 用户资产资源全扫', () => {
  it('users：封禁（带原因）→ 列表 status=1 → 解封清原因；audit-logs 有痕', async () => {
    const userId = await seedE2EUser(api.db);
    const banned = await http(api.baseUrl, `/v1/users/${userId}`, {
      method: 'PATCH',
      token,
      body: { status: 1, freezeReason: 'E2E 违规' },
    });
    expect(banned.status).toBe(200);
    const profile = await http(api.baseUrl, `/v1/users/${userId}`, { token });
    expect(profile.body.status).toBe(1);
    expect(profile.body.freezeReason).toBe('E2E 违规');

    const logs = await http(api.baseUrl, `/v1/users/${userId}/audit-logs`, { token });
    expect((logs.body.rows as unknown[]).length).toBeGreaterThan(0);

    await http(api.baseUrl, `/v1/users/${userId}`, { method: 'PATCH', token, body: { status: 0 } });
    const unbanned = await http(api.baseUrl, `/v1/users/${userId}`, { token });
    expect(unbanned.body.status).toBe(0);
    expect(unbanned.body.freezeReason).toBeNull();
  });

  it('keys：列表（无过滤信封）+ 补丁状态枚举边界', async () => {
    const list = await http(api.baseUrl, '/v1/admin-keys', { token });
    expect(list.status).toBe(200);
    expect(list.body).toHaveProperty('rows');
    expect(list.body).toHaveProperty('total');
    expect((await http(api.baseUrl, '/v1/admin-keys/999999999', { method: 'PATCH', token, body: { status: 1 } })).status).toBe(404);
  });

  it('plans：创建 → 改价 → 删除（无引用 → 200）', async () => {
    const created = await http(api.baseUrl, '/v1/plans', {
      token,
      body: { name: e2eUid('plan'), price: '9', quotaAmount: '9', periodDays: 7 },
    });
    expect(created.status).toBe(201);
    const planId = created.body.id as number;

    const patched = await http(api.baseUrl, `/v1/plans/${planId}`, {
      method: 'PATCH',
      token,
      body: { price: '12', status: 0 },
    });
    expect(patched.status).toBe(200);
    expect((await http(api.baseUrl, `/v1/plans/${planId}`, { method: 'DELETE', token })).status).toBe(200);
  });

  it('redeem：批次 → 码列表 → 作废一枚（状态 0→2）', async () => {
    const created = await http(api.baseUrl, '/v1/redeem-batches', {
      token,
      body: { name: e2eUid('batch'), amount: '5', count: 2 },
    });
    expect(created.status).toBe(201);
    const batchId = (created.body.batch as { id: number }).id;
    trackE2E.batch(batchId);
    expect((created.body.codes as string[]).length).toBe(2);

    const detail = await http(api.baseUrl, `/v1/redeem-batches/${batchId}`, { token });
    expect(detail.status).toBe(200);

    const codes = await http(api.baseUrl, `/v1/redeem-batches/${batchId}/codes`, { token });
    expect(codes.body.total).toBe(2);
    const codeId = (codes.body.rows as Array<{ id: number }>)[0]!.id;
    expect((await http(api.baseUrl, `/v1/redeem-batches/codes/${codeId}/revoke`, { method: 'POST', token })).status).toBe(200);
    const after = await http(api.baseUrl, `/v1/redeem-batches/${batchId}/codes?status=2`, { token });
    expect(after.body.total).toBe(1);
  });

  it('subscriptions：空列表信封 + 不存在取消 404', async () => {
    const list = await http(api.baseUrl, '/v1/subscriptions', { token });
    expect(list.status).toBe(200);
    expect(list.body).toHaveProperty('rows');
    expect((await http(api.baseUrl, '/v1/subscriptions/999999999/cancel', { method: 'POST', token })).status).toBe(404);
  });
});
