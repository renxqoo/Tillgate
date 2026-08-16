import { afterAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@ai-gateway/db';
import { loadRootEnvFile } from '@ai-gateway/http';
import { subscriptionRoutes } from '../subscriptions.js';
import { makeClientTestApp, makeServices } from '../../test/helpers.js';

/**
 * 套餐购买/变更入参校验（纯 zod 层，不触 DB）：
 * 席位数量上限 SEATS_MAX=1000 —— 防 numeric 溢出与恶意超大值把 4xx 变 500。
 */

loadRootEnvFile();

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);

describe('订阅购买/变更参数校验', () => {
  it('购买 quantity 超上限 → 400', async () => {
    const app = makeClientTestApp(1, { '/subscriptions': subscriptionRoutes(makeServices(db)) });
    const res = await app.request('/api/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId: 1, quantity: 1001 }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('变更 quantity 超上限 → 400；合法边界（1000）通过校验层', async () => {
    const app = makeClientTestApp(1, { '/subscriptions': subscriptionRoutes(makeServices(db)) });
    const over = await app.request('/api/subscriptions/1/change', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetPlanId: 1, quantity: 1001 }),
    });
    expect(over.status).toBe(400);

    // 边界值 1000 合法（会进 handler 走业务校验，这里预期 404/4xx 业务错误而非 400 校验错误）
    const edge = await app.request('/api/subscriptions/1/change', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetPlanId: 1, quantity: 1000 }),
    });
    expect(edge.status).not.toBe(400);
    expect(edge.status).toBe(404); // 无此订阅（业务错误，校验已通过）
  });
});

afterAll(async () => {
  await db.$client.end().catch(() => {});
});
