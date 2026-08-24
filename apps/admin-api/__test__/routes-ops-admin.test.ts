/**
 * P4 契约测试（generation-tasks / payment-orders 族）：任务列表信封与实扣回填、
 * kind/status 词表外 400、limit 上界 200;订单列表信封/q 透传/排序白名单外 400;
 * close 无请求体 + uuid 校验 + 409 语义（billing.order_state_conflict）。
 */
import { describe, expect, it, vi } from 'vitest';
import { createAdminApp } from '../src/app';
import { authHeader, fakeDeps } from './helpers';

const taskRow = (overrides: Record<string, unknown> = {}) => ({
  taskId: '019c0b7d-0000-7000-8000-000000000011',
  requestId: '019c0b7d-0000-7000-8000-000000000099',
  kind: 'video',
  status: 'succeeded',
  userId: 21,
  channelId: 2,
  upstreamTaskId: 'up-1',
  failReason: null,
  result: { videoUrl: 'https://v/1' },
  billingStatus: 'settled',
  createdAt: 1_755_916_800_000,
  finishedAt: 1_755_917_000_000,
  expiresAt: 1_755_926_800_000,
  ...overrides,
});

const orderRow = {
  id: '019c0b7d-0000-7000-8000-0000000000aa',
  provider: 'epay',
  providerOrderId: '019c0b7d-0000-7000-8000-0000000000aa',
  userId: 21,
  userDisplayName: 'alice',
  userSubject: 'alice@example.com',
  amount: '10',
  creditAmount: '10',
  currency: 'CNY',
  status: 0,
  failureReason: null,
  createdAt: new Date('2026-08-23T01:00:00.000Z'),
  paidAt: new Date('2026-08-23T01:05:00.000Z'),
  creditedAt: new Date('2026-08-23T01:06:00.000Z'),
};

// 模块级:settledAmounts 替身(提出 describe/it 回调,避免 vi.fn 内回调深层嵌套)
const fakeSettledAmounts = async (ids: readonly string[]) => new Map(ids.map((id) => [id, '0.42']));

describe('generation-tasks（P4）', () => {
  it('items/total 信封 + kind/status/limit/offset 透传 + settled 批量回填 + epoch→ISO', async () => {
    const adminList = vi.fn(async () => ({
      rows: [
        taskRow(),
        // 未结算且无终态时间戳:finishedAt null 侧 + settledAmount null
        taskRow({
          taskId: 't2',
          billingStatus: null,
          status: 'failed',
          failReason: 'upstream',
          finishedAt: null,
        }),
      ],
      total: 2,
    }));
    const settledAmounts = vi.fn(fakeSettledAmounts);
    const app = createAdminApp(fakeDeps({ generationTasks: { adminList, settledAmounts } }));
    const res = await app.request(
      '/v1/generation-tasks?kind=video&status=failed&limit=50&offset=100',
      {
        headers: authHeader(),
      },
    );
    expect(res.status).toBe(200);
    expect(adminList).toHaveBeenCalledWith({
      kind: 'video',
      status: 'failed',
      limit: 50,
      offset: 100,
    });
    // 只回查 settled 行(页内批量)
    expect(settledAmounts).toHaveBeenCalledWith(['019c0b7d-0000-7000-8000-000000000011']);

    const body = (await res.json()) as { items: Array<Record<string, unknown>>; total: number };
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({
      id: '019c0b7d-0000-7000-8000-000000000011',
      billingStatus: 'settled',
      settledAmount: '0.42',
      createdAt: '2025-08-23T02:40:00.000Z', // epoch ms → ISO(v1 wire 形状)
    });
    // 未结算行 settledAmount = null(不进回查集合)
    expect(body.items[1]).toMatchObject({ id: 't2', settledAmount: null });
  });

  it('kind/status 词表外与 limit 越界一律 400;缺省 limit=50/offset=0', async () => {
    const adminList = vi.fn(async () => ({ rows: [], total: 0 }));
    const app = createAdminApp(fakeDeps({ generationTasks: { adminList } }));
    await app.request('/v1/generation-tasks', { headers: authHeader() });
    expect(adminList).toHaveBeenLastCalledWith({ limit: 50, offset: 0 });
    for (const qs of ['kind=image', 'status=pending', 'limit=201', 'limit=0', 'offset=-1']) {
      const res = await app.request(`/v1/generation-tasks?${qs}`, { headers: authHeader() });
      expect(res.status, qs).toBe(400);
    }
  });
});

describe('payment-orders（P4）', () => {
  it('列表信封 + q 透传 + Date→ISO', async () => {
    const list = vi.fn(async () => ({ rows: [orderRow], total: 1 }));
    const app = createAdminApp(fakeDeps({ paymentAdmin: { list } }));
    // 无 q:可选展开走 undefined 侧(q 双锚仅在显式提供时生效)
    const bare = await app.request('/v1/payment-orders', { headers: authHeader() });
    expect(bare.status).toBe(200);
    expect(list).toHaveBeenLastCalledWith({
      sortBy: 'createdAt',
      order: 'desc',
      limit: 20,
      offset: 0,
    });

    const res = await app.request(
      '/v1/payment-orders?q=019c0b7d&page=1&page_size=20&sort_by=amount&order=desc',
      {
        headers: authHeader(),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect((body.rows as Array<Record<string, unknown>>)[0]).toMatchObject({
      createdAt: '2026-08-23T01:00:00.000Z',
      paidAt: '2026-08-23T01:05:00.000Z',
      creditedAt: '2026-08-23T01:06:00.000Z',
    });
    expect(list).toHaveBeenCalledWith({
      q: '019c0b7d',
      sortBy: 'amount',
      order: 'desc',
      limit: 20,
      offset: 0,
    });
  });

  it('close:无请求体直调 + orderId/reason 注入 + 成功 {ok:true}', async () => {
    const close = vi.fn(async () => ({ ok: true as const }));
    const app = createAdminApp(fakeDeps({ paymentAdmin: { close } }));
    const res = await app.request('/v1/payment-orders/019c0b7d-0000-7000-8000-0000000000aa/close', {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // 留痕文案经装配注入(不写死在路由);v1 同字面
    expect(close).toHaveBeenCalledWith({
      orderId: '019c0b7d-0000-7000-8000-0000000000aa',
      reason: '管理员手动关闭',
    });
  });

  it('close:uuid 形状外 400(invalid_param);关单失败 409(billing.order_state_conflict)', async () => {
    const app = createAdminApp(fakeDeps({ paymentAdmin: {} }));
    const badUuid = await app.request('/v1/payment-orders/not-a-uuid/close', {
      method: 'POST',
      headers: authHeader(),
    });
    expect(badUuid.status).toBe(400);
    expect(await badUuid.json()).toMatchObject({ error: { code: 'admin.invalid_param' } });

    // billing 错误目录经 error-face 渲染 409(v1 conflict 语义)
    const conflictApp = createAdminApp(
      fakeDeps({
        paymentAdmin: {
          close: async () => {
            const { BillingErrors } = await import('@tillgate/billing');
            throw BillingErrors.business('order_state_conflict', { orderId: 'x' });
          },
        },
      }),
    );
    const conflict = await conflictApp.request(
      '/v1/payment-orders/019c0b7d-0000-7000-8000-0000000000aa/close',
      { method: 'POST', headers: authHeader() },
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: { code: 'billing.order_state_conflict' },
    });
  });
});
