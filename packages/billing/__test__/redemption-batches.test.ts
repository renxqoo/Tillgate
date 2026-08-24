/**
 * 兑换批次管理契约测试（U6;内存 stand-in;v1 redeem.test.ts 行为规格）：
 * 明文码仅创建一次返回（库内只落哈希）/ 批次列表详情 / 批内码列表 / 单码作废 CAS 统一 404。
 */
import { describe, expect, it } from 'vitest';
import { createRedeemBatchApi } from '../src/application/redeem-batches/redeem-batches.js';
import { createInMemoryBillingWorld } from '../src/testing/in-memory-billing-store.js';
import { createInMemoryPaymentStores } from '../src/testing/in-memory-payment-stores.js';
import { sha256Hex } from '../src/application/redemption/redemption.js';
import { defined } from './defined.js';

function harness() {
  const world = createInMemoryBillingWorld();
  const payment = createInMemoryPaymentStores();
  const generated: string[] = [];
  let seq = 0;
  const api = createRedeemBatchApi({
    store: world.billing,
    codes: payment.codeStore,
    generateCode: () => {
      seq += 1;
      const code = `RC-PLAINTEXT-${seq}`;
      generated.push(code);
      return code;
    },
  });
  return { api, codes: payment.codeStore, generated };
}

describe('createRedeemBatchApi（U6）', () => {
  it('创建:明文一次返回 + 库内哈希(可按哈希反查)+ 批次行落 createdBy/remark', async () => {
    const { api, codes, generated } = harness();
    const result = await api.create({
      createdBy: 7,
      name: '开学季',
      remark: '市场活动',
      amount: '10',
      count: 3,
      expiresAt: new Date('2027-01-01T00:00:00Z'),
    });
    expect(result.batch).toMatchObject({ name: '开学季', amount: '10', total: 3 });
    expect(result.codes).toEqual(generated);
    expect(result.codes).toHaveLength(3);
    // 库内只落哈希:按任一明文哈希可查到码行
    const found = await codes.findByCodeHash(null as never, sha256Hex(defined(result.codes[0])));
    expect(found).toMatchObject({ status: 0, batchId: result.batch.id });
    // 明文绝不出现于存储面
    expect(JSON.stringify(found)).not.toContain('RC-PLAINTEXT');

    const detail = await api.detail(result.batch.id);
    expect(detail).toMatchObject({ name: '开学季', remark: '市场活动', total: 3, createdBy: 7 });
  });

  it('列表 q/分页;批内码列表 status 过滤;哈希脱敏归 presenter 不在此层', async () => {
    const { api } = harness();
    const first = await api.create({ createdBy: 1, name: 'batch-a', amount: '5', count: 2 });
    await api.create({ createdBy: 1, name: 'batch-b', amount: '6', count: 1 });

    const all = await api.list({ sortBy: 'id', order: 'asc', limit: 10, offset: 0 });
    expect(all.total).toBe(2);
    const filtered = await api.list({
      q: 'batch-a',
      sortBy: 'id',
      order: 'asc',
      limit: 10,
      offset: 0,
    });
    expect(filtered.rows.map((r) => r.id)).toEqual([first.batch.id]);

    const codePage = await api.codes({
      batchId: first.batch.id,
      sortBy: 'id',
      order: 'asc',
      limit: 10,
      offset: 0,
    });
    expect(codePage.total).toBe(2);
    expect(codePage.rows[0]).toMatchObject({ status: 0, usedBy: null });
    expect(typeof defined(codePage.rows[0]).codeHash).toBe('string');

    await expect(
      api.codes({ batchId: 999, sortBy: 'id', order: 'asc', limit: 5, offset: 0 }),
    ).rejects.toMatchObject({ code: 'billing.redeem_batch_not_found' });
    await expect(api.detail(999)).rejects.toMatchObject({ code: 'billing.redeem_batch_not_found' });
  });

  it('作废 CAS:未用可废;已废/未知统一 redeem_code_not_found(不泄漏状态差异)', async () => {
    const { api, codes } = harness();
    const created = await api.create({ createdBy: 1, name: 'b', amount: '1', count: 2 });
    const [firstCode] = created.codes;
    const row = await codes.findByCodeHash(null as never, sha256Hex(defined(firstCode)));
    const codeId = defined(row).id;

    await expect(api.revoke({ codeId })).resolves.toEqual({ ok: true });
    // 再废(已废)→ 404 语义
    await expect(api.revoke({ codeId })).rejects.toMatchObject({
      code: 'billing.redeem_code_not_found',
    });
    await expect(api.revoke({ codeId: 999999 })).rejects.toMatchObject({
      code: 'billing.redeem_code_not_found',
    });
  });

  it('generateCode 注入缝:缺省生成器由装配注入(此处替身计数)', async () => {
    const { api, generated } = harness();
    await api.create({ createdBy: 1, name: 'n', amount: '1', count: 4 });
    expect(generated).toHaveLength(4);
  });
});
