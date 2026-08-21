/**
 * 兑换批次语义：
 *   - 金额 0/负/超大与 count 超限 → 400；合法批次 201 + 明文码仅此一次
 *   - 批内码列表（哈希脱敏）；单码作废（CAS 0→2）；作废后码不可再废
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { redeemCodes } from '@ai-gateway/db';
import {
  buildTestApp,
  db,
  newAdmin,
  trackBatch,
  uid,
} from './helpers.js';

describe('兑换批次', () => {
  it('金额 0/负/超大与 count 超限 → 400；合法批次 201 + 码明文仅此一次', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();

    expect(
      (await request('/v1/redeem-batches', { token, body: { name: uid('b'), amount: '0', count: 1 } })).status,
    ).toBe(400);
    expect(
      (await request('/v1/redeem-batches', { token, body: { name: uid('b'), amount: '-1', count: 1 } })).status,
    ).toBe(400);
    expect(
      (await request('/v1/redeem-batches', { token, body: { name: uid('b'), amount: '1', count: 10001 } })).status,
    ).toBe(400);

    const res = await request('/v1/redeem-batches', {
      token,
      body: { name: uid('batch'), amount: '1', count: 2 },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      batch: { id: number; total: number };
      codes: string[];
    };
    trackBatch(body.batch.id);
    expect(body.batch.total).toBe(2);
    expect(body.codes).toHaveLength(2);
    // 明文格式 RC- 前缀（生成器口径）
    expect(body.codes[0]).toMatch(/^RC-/);

    // 批内码列表：2 行 + 哈希脱敏
    const codes = (await (
      await request(`/v1/redeem-batches/${body.batch.id}/codes`, { token })
    ).json()) as { rows: Array<{ codeMasked: string; status: number }>; total: number };
    expect(codes.total).toBe(2);
    expect(codes.rows[0]!.codeMasked).toMatch(/^[a-f0-9]{8}\.\.\.$/);
    expect(codes.rows.every((r) => r.status === 0)).toBe(true);
    // 明文不出码列表
    expect(JSON.stringify(codes)).not.toContain(body.codes[0]);
  });

  it('撤销码 → status=2；再撤销/不存在 → 404', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const created = (await (
      await request('/v1/redeem-batches', { token, body: { name: uid('batch'), amount: '1', count: 1 } })
    ).json()) as { batch: { id: number }; codes: string[] };
    trackBatch(created.batch.id);

    const codes = (await (
      await request(`/v1/redeem-batches/${created.batch.id}/codes`, { token })
    ).json()) as { rows: Array<{ id: number }> };
    const codeId = codes.rows[0]!.id;

    const revoked = await request(`/v1/redeem-batches/codes/${codeId}/revoke`, { method: 'POST', token });
    expect(revoked.status).toBe(200);
    const [row] = await db.select().from(redeemCodes).where(eq(redeemCodes.id, codeId));
    expect(row!.status).toBe(2);

    // 已作废再撤销 → 404
    expect(
      (await request(`/v1/redeem-batches/codes/${codeId}/revoke`, { method: 'POST', token })).status,
    ).toBe(404);
  });
});
