/**
 * E2E ⑤运维查询全扫（真进程）：stats 双端点 / usage-logs / logs / audit-logs /
 * payment-orders / generation-tasks / billing-operations（dead 列表 + 参数边界）/
 * tracing 五端点 / notifications CRUD。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { e2eDb, http, loginAdmin, seedAdmin, startAdminApi, e2eUid, type E2EAdminApi } from './e2e-kit.js';

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
  await api.db.$client.end().catch(() => {});
});

describe('E2E 运维查询', () => {
  it('stats/overview + stats/usage：结构完整', async () => {
    const overview = await http(api.baseUrl, '/v1/stats/overview', { token });
    expect(overview.status).toBe(200);
    expect(overview.body.today).toHaveProperty('requests');
    expect(overview.body).toHaveProperty('channelHealth');
    const usage = await http(api.baseUrl, '/v1/stats/usage?group=model', { token });
    expect(usage.status).toBe(200);
    expect(Array.isArray(usage.body.list)).toBe(true);
  });

  it('usage-logs / logs / audit-logs：信封 + 过滤', async () => {
    const usage = await http(api.baseUrl, '/v1/usage-logs?estimated=false&page_size=5', { token });
    expect(usage.status).toBe(200);
    expect(usage.body).toHaveProperty('rows');
    const logs = await http(api.baseUrl, '/v1/logs?statusCode=2xx', { token });
    expect(logs.status).toBe(200);
    const audits = await http(api.baseUrl, '/v1/audit-logs?page_size=5', { token });
    expect(audits.status).toBe(200);
    // estimated 字符串陷阱：'false' 不误吞
    expect((await http(api.baseUrl, '/v1/usage-logs?estimated=false', { token })).status).toBe(200);
  });

  it('payment-orders / generation-tasks / billing-operations：信封与边界', async () => {
    expect((await http(api.baseUrl, '/v1/payment-orders', { token })).status).toBe(200);
    expect((await http(api.baseUrl, '/v1/generation-tasks?kind=video&limit=10', { token })).status).toBe(200);
    // status=dead 必填
    expect((await http(api.baseUrl, '/v1/billing-operations', { token })).status).toBe(400);
    const dead = await http(api.baseUrl, '/v1/billing-operations?status=dead', { token });
    expect(dead.status).toBe(200);
    expect(dead.body).toHaveProperty('rows');
  });

  it('tracing：五端点全 200', async () => {
    expect((await http(api.baseUrl, '/v1/tracing/recent', { token })).status).toBe(200);
    expect((await http(api.baseUrl, '/v1/tracing/recent?errorsOnly=true&minDurationMs=1', { token })).status).toBe(200);
    expect((await http(api.baseUrl, '/v1/tracing/traces/abcdef0123456789', { token })).status).toBe(200);
    expect((await http(api.baseUrl, `/v1/tracing/by-request/${e2eUid('r')}`, { token })).status).toBe(200);
    expect((await http(api.baseUrl, '/v1/tracing/topology?hours=24', { token })).status).toBe(200);
    const stats = await http(api.baseUrl, '/v1/tracing/stats', { token });
    expect(stats.status).toBe(200);
    expect(stats.body.storage).toHaveProperty('spans');
  });

  it('notifications：email 渠道建改删 + 测试事件', async () => {
    const created = await http(api.baseUrl, '/v1/notifications', {
      token,
      body: { name: e2eUid('mail'), type: 'email', config: { recipients: ['e2e@example.test'] }, events: ['billing_dead'] },
    });
    expect(created.status).toBe(201);
    const id = (created.body as { id: number }).id;
    expect((await http(api.baseUrl, `/v1/notifications/${id}`, { method: 'PATCH', token, body: { status: 1 } })).status).toBe(200);
    expect((await http(api.baseUrl, `/v1/notifications/${id}/test`, { method: 'POST', token })).status).toBe(200);
    expect((await http(api.baseUrl, `/v1/notifications/${id}`, { method: 'DELETE', token })).status).toBe(200);
  });
});
