/**
 * billing 管理域契约测试：
 * 套餐 kind×周期 4xx/删除守卫 409/后置审计；兑换批次明文一次返回 + 哈希脱敏 + 作废统一 404；
 * 死信复审乐观锁 409/命令守卫;订阅管理列表信封。
 */
import { describe, expect, it, vi } from 'vitest';
import { BillingErrors } from '@tillgate/billing';
import { createAdminApp } from '../src/app';
import { fakeDeps } from './helpers';

const json = { authorization: 'Bearer admin-session-token', 'content-type': 'application/json' };

const planRow = {
  id: 11,
  name: '标准月',
  kind: 'subscription',
  sortOrder: null,
  price: '30.000000000000000000',
  periodDays: 30,
  quotaAmount: '100.000000000000000000',
  allowSeats: false,
  status: 0,
};

describe('GET|POST|PATCH|DELETE /v1/plans', () => {
  it('创建 201 + 金额归一 + 后置审计;kind×周期 4xx → billing.invalid_period_days', async () => {
    const postAudit = vi.fn(async () => {});
    const app2 = createAdminApp({
      ...fakeDeps({
        plans: {
          // kind×周期一致性规则在 billing 用例层——fake 承载之
          create: async (input: { kind?: string; periodDays?: number }) => {
            if (input.kind === 'pack' && input.periodDays != null && input.periodDays !== 0) {
              throw BillingErrors.business('invalid_period_days', { kind: 'pack' });
            }
            return planRow;
          },
        },
      }),
      postAudit,
    });
    const created = await app2.request('/v1/plans', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ name: '标准月', price: '30', periodDays: 30, quotaAmount: '100' }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      price: '30',
      quotaAmount: '100',
      kind: 'subscription',
    });
    expect(postAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'plan.create', adminId: 7, targetId: 11 }),
    );

    const badKind = await app2.request('/v1/plans', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        name: 'x',
        price: '1',
        quotaAmount: '1',
        kind: 'pack',
        periodDays: 7,
      }),
    });
    expect(badKind.status).toBe(400);
    expect(await badKind.json()).toMatchObject({ error: { code: 'billing.invalid_period_days' } });
    // kind 不可变:strictObject 拒未知键
    const immutable = await app2.request('/v1/plans/11', {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ kind: 'pack' }),
    });
    expect(immutable.status).toBe(400);
  });

  it('列表信封;更新透传;删除守卫 409 billing.plan_in_use;未引用 200', async () => {
    const app = createAdminApp(
      fakeDeps({
        plans: {
          list: async () => ({ rows: [planRow], total: 1 }),
          update: async () => ({ ...planRow, status: 1 }),
          remove: async (input: { planId: number }) => {
            if (input.planId === 99) {
              throw BillingErrors.business('plan_in_use', { planId: 99 });
            }
            return { ok: true as const };
          },
        },
      }),
    );
    const list = await app2_get(app, '/v1/plans?sort_by=price&order=asc');
    expect(list).toMatchObject({ rows: [{ id: 11, price: '30' }], total: 1 });

    const patched = await app.request('/v1/plans/11', {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ status: 1, price: '31' }),
    });
    expect(await patched.json()).toMatchObject({ status: 1 });

    const guarded = await app.request('/v1/plans/99', {
      method: 'DELETE',
      headers: { authorization: json.authorization },
    });
    expect(guarded.status).toBe(409);
    expect(await guarded.json()).toMatchObject({ error: { code: 'billing.plan_in_use' } });
    const removed = await app.request('/v1/plans/11', {
      method: 'DELETE',
      headers: { authorization: json.authorization },
    });
    expect(await removed.json()).toEqual({ ok: true });
  });
});

describe('/v1/redeem-batches 族', () => {
  const batchRow = {
    id: 21,
    name: '开学季',
    remark: null,
    amount: '10.000000000000000000',
    total: 2,
    usedCount: 0,
    createdBy: 7,
    createdAt: new Date('2026-08-01T00:00:00Z'),
  };

  it('创建:明文一次返回 201 + 审计;列表/详情金额归一;码列表哈希脱敏', async () => {
    const app = createAdminApp(
      fakeDeps({
        redeemBatches: {
          create: async () => ({
            batch: { id: 21, name: '开学季', amount: '10.000000000000000000', total: 2 },
            codes: ['RC-A', 'RC-B'],
          }),
          list: async () => ({ rows: [batchRow], total: 1 }),
          detail: async () => batchRow,
          codes: async () => ({
            rows: [
              {
                id: 5,
                codeHash: 'abcdef1234567890abcdef1234567890abcdef12',
                status: 0,
                usedBy: null,
                usedAt: null,
                expiresAt: null,
              },
            ],
            total: 1,
          }),
        },
      }),
    );
    const created = await app.request('/v1/redeem-batches', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        name: '开学季',
        amount: '10',
        count: 2,
        expiresAt: '2099-01-01T00:00:00Z',
      }),
    });
    // 非法过期时间 → refine 拒 400
    const badExpiry = await app.request('/v1/redeem-batches', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ name: '坏', amount: '10', count: 1, expiresAt: 'not-a-date' }),
    });
    expect(badExpiry.status).toBe(400);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      batch: { amount: '10.000000000000000000', total: 2 },
      codes: ['RC-A', 'RC-B'],
    });
    const list = await app2_get(app, '/v1/redeem-batches?q=开学');
    expect(list).toMatchObject({ rows: [{ amount: '10', createdBy: '7' }], total: 1 });
    const detail = await app.request('/v1/redeem-batches/21', {
      headers: { authorization: json.authorization },
    });
    expect(await detail.json()).toMatchObject({ amount: '10' });
    const codes = await app2_get(app, '/v1/redeem-batches/21/codes?status=0');
    expect(codes).toMatchObject({
      rows: [{ id: 5, codeMasked: 'abcdef12****ef12', status: 0, usedBy: null }],
      total: 1,
    });
  });

  it('作废:失败统一 billing.redeem_code_not_found;成功 {ok:true}', async () => {
    const app = createAdminApp(
      fakeDeps({
        redeemBatches: {
          revoke: async (input: { codeId: number }) => {
            if (input.codeId === 404) {
              throw BillingErrors.business('redeem_code_not_found', { codeId: '404' });
            }
            return { ok: true as const };
          },
        },
      }),
    );
    const failed = await app.request('/v1/redeem-batches/codes/404/revoke', {
      method: 'POST',
      headers: { authorization: json.authorization },
    });
    expect(failed.status).toBe(404);
    expect(await failed.json()).toMatchObject({ error: { code: 'billing.redeem_code_not_found' } });
    const ok = await app.request('/v1/redeem-batches/codes/5/revoke', {
      method: 'POST',
      headers: { authorization: json.authorization },
    });
    expect(await ok.json()).toEqual({ ok: true });
  });
});

describe('/v1/billing-operations 死单复核', () => {
  it('list status=dead 专属(其他值 400);行金额归一', async () => {
    const app = createAdminApp(
      fakeDeps({
        review: {
          listDead: async () => ({
            rows: [
              {
                requestId: '00000000-0000-4000-8000-000000000001',
                userId: 42,
                status: 'dead',
                revision: 3,
                attempt: 2,
                failureCode: 'billing.poison_receipt',
                lastError: null,
                reservedAmount: '5.000000000000000000',
                createdAt: new Date('2026-08-01T00:00:00Z'),
              },
            ],
            total: 1,
          }),
        },
      }),
    );
    const ok = await app2_get(app, '/v1/billing-operations?status=dead&page_size=50');
    expect(ok).toMatchObject({
      rows: [{ requestId: '00000000-0000-4000-8000-000000000001', reservedAmount: '5' }],
      total: 1,
      pageSize: 50,
    });
    const bad = await app.request('/v1/billing-operations?status=pending', {
      headers: { authorization: json.authorization },
    });
    expect(bad.status).toBe(400);
  });

  it('retry/abandon:命令体透传(幂等键头);乐观锁 409 billing.state_conflict;空理由 400', async () => {
    const retryDead = vi.fn(async () => ({
      requestId: '00000000-0000-4000-8000-00000000000a',
      userId: 42,
      status: 'retry_wait',
      revision: 4,
      replayed: false,
    }));
    const app = createAdminApp(
      fakeDeps({
        review: {
          retryDead,
          abandonDead: async () => {
            throw BillingErrors.business('state_conflict', { requestId: 'x' });
          },
        },
      }),
    );
    const retried = await app.request(
      '/v1/billing-operations/00000000-0000-4000-8000-00000000000a/retry',
      {
        method: 'POST',
        headers: { ...json, 'idempotency-key': 'rv-1' },
        body: JSON.stringify({ expectedRevision: 3, reason: '上游恢复', evidenceRefs: ['t-1'] }),
      },
    );
    expect(await retried.json()).toMatchObject({ status: 'retry_wait', revision: 4 });
    expect(retryDead).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'rv-1', expectedRevision: 3, adminId: 7 }),
    );
    const conflicted = await app.request(
      '/v1/billing-operations/00000000-0000-4000-8000-00000000000a/abandon',
      {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ expectedRevision: 0, reason: 'stale' }),
      },
    );
    expect(conflicted.status).toBe(409);
    expect(await conflicted.json()).toMatchObject({ error: { code: 'billing.state_conflict' } });
    const badReason = await app.request(
      '/v1/billing-operations/00000000-0000-4000-8000-00000000000a/retry',
      {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ expectedRevision: 3, reason: '' }),
      },
    );
    expect(badReason.status).toBe(400);
    const badRequestId = await app.request('/v1/billing-operations/not-a-uuid/retry', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ expectedRevision: 3, reason: 'x' }),
    });
    expect(badRequestId.status).toBe(400);
    expect(await badRequestId.json()).toMatchObject({ error: { code: 'admin.invalid_param' } });
  });
});

describe('GET /v1/subscriptions 管理列表(P1)', () => {
  it('过滤透传 + 剩余额度归一信封', async () => {
    const app = createAdminApp(
      fakeDeps({
        subscriptions: {
          adminList: async () => ({
            rows: [
              {
                id: 31,
                userId: 42,
                userSubject: 'user-42',
                userDisplayName: null,
                planId: 11,
                planName: '标准月',
                startAt: new Date('2026-08-01T00:00:00Z'),
                endAt: new Date('2026-09-01T00:00:00Z'),
                quotaAmount: '100.000000000000000000',
                usedAmount: '30',
                reservedAmount: '20',
                quantity: 1,
                price: '30',
                remainingAmount: '50.000000000000000000',
                status: 0,
                createdAt: new Date('2026-08-01T00:00:00Z'),
              },
            ],
            total: 1,
          }),
        },
      }),
    );
    const body = await app2_get(
      app,
      '/v1/subscriptions?planId=11&userId=42&status=0&sort_by=usedAmount',
    );
    expect(body).toMatchObject({
      rows: [
        {
          id: 31,
          planName: '标准月',
          quotaAmount: '100',
          remainingAmount: '50',
          userSubject: 'user-42',
        },
      ],
      total: 1,
    });
  });
});

/** GET 快捷(带会话头) */
async function app2_get(app: ReturnType<typeof createAdminApp>, path: string) {
  const res = await app.request(path, { headers: { authorization: json.authorization } });
  return (await res.json()) as Record<string, unknown>;
}
