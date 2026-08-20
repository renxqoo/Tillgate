/**
 * 套餐校验语义（v1 plans-validation 的 v2 对位）：
 *   - 包月 periodDays=0 / 缺失 → 400 invalid_period_days
 *   - 加油包 periodDays=30 → 400；缺省 → 201 且落库 0
 *   - 价格 Infinity（JSON 1e999 溢出）→ 400（防 numeric 溢出 500）
 *   - PATCH kind（不可变）→ 400；合法更新 periodDays 正常
 *   - 路径参数非正整数 → 400
 *   - 删除守卫：存在历史订阅（已取消）→ 409 plan_in_use
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { plans, userSubscriptions } from '@ai-gateway/db';
import { systemContext, createSubscriptionDomain } from '@ai-gateway/service';
import {
  buildTestApp,
  db,
  fundUser,
  newAdmin,
  newPlanRow,
  newUserRow,
  uid,
  wallet,
} from './helpers.js';

const ctx = systemContext('aav2-plan-test');

describe('套餐校验（TDD 参数边界）', () => {
  it('包月 periodDays=0 → 400（防「买到立即到期」）；缺失 → 400', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const zero = await request('/v1/plans', {
      token,
      body: { name: uid('p'), price: '30', quotaAmount: '30', periodDays: 0 },
    });
    expect(zero.status).toBe(400);
    expect(((await zero.json()) as { error: { code: string } }).error.code).toBe('invalid_period_days');

    const missing = await request('/v1/plans', {
      token,
      body: { name: uid('p'), price: '30', quotaAmount: '30' },
    });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('invalid_period_days');
  });

  it('加油包 periodDays=30 → 400；缺省 → 201 且落库 0', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const bad = await request('/v1/plans', {
      token,
      body: { name: uid('p'), kind: 'pack', price: '5', quotaAmount: '5', periodDays: 30 },
    });
    expect(bad.status).toBe(400);

    const name = uid('pack');
    const ok = await request('/v1/plans', {
      token,
      body: { name, kind: 'pack', price: '5', quotaAmount: '5' },
    });
    expect(ok.status).toBe(201);
    const [row] = await db.select().from(plans).where(eq(plans.name, name));
    expect(row!.periodDays).toBe(0);
  });

  it('价格 Infinity（JSON 1e999 → JS Infinity）→ 400（防 numeric 溢出 500）', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const res = await request('/v1/plans', {
      token,
      body: undefined,
    });
    void res;
    // 直接注入 Infinity（等价于 raw JSON 里 1e999 的解析结果）——zod finite() 收口
    const overflow = await request('/v1/plans', {
      token,
      body: { name: uid('p'), price: Number('1e999'), quotaAmount: '30', periodDays: 30 },
    });
    expect(overflow.status).toBe(400);
  });

  it('PATCH kind（不可变）→ 400；合法更新 periodDays 正常', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const planId = await newPlanRow();
    expect(
      (await request(`/v1/plans/${planId}`, { method: 'PATCH', token, body: { kind: 'pack' } })).status,
    ).toBe(400);
    expect(
      (await request(`/v1/plans/${planId}`, { method: 'PATCH', token, body: { periodDays: 0 } })).status,
    ).toBe(400);
    const ok = await request(`/v1/plans/${planId}`, { method: 'PATCH', token, body: { periodDays: 365 } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { periodDays: number }).periodDays).toBe(365);
  });

  it('路径参数非正整数 → 400 invalid_param', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const res = await request('/v1/plans/abc', { method: 'PATCH', token, body: { name: 'x' } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_param');
  });

  it('删除守卫：存在历史订阅（已取消）→ 409 plan_in_use', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const userId = await newUserRow();
    const planId = await newPlanRow({ price: '10', quotaAmount: '10' });
    await fundUser(userId, '50');
    const domain = createSubscriptionDomain({ db, wallet });
    const purchased = await domain.purchase(ctx, { operationId: uid('buy'), userId, planId, quantity: 1 });
    await domain.cancel(ctx, { operationId: uid('cxl'), subscriptionId: purchased.subscriptionId });
    // 已取消（status=2 历史行）仍阻止删除
    const [subRow] = await db
      .select()
      .from(userSubscriptions)
      .where(eq(userSubscriptions.id, purchased.subscriptionId));
    expect(subRow!.status).toBe(2);

    const res = await request(`/v1/plans/${planId}`, { method: 'DELETE', token });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('plan_in_use');
  });
});
