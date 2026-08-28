/**
 * 死信复核契约测试（内存 stand-in）：
 * list dead 投影 / retry CAS（乐观锁 + 清失败态）/ abandon CAS + 三路归还 /
 * operations 幂等（同键重放、异参 409）/ 审计与业务同事务（注入 port）。
 */
import { describe, expect, it, vi } from 'vitest';
import { createSettlementApi } from '../src/application/settlement/settlement.js';
import { createDefaultFundingRegistry } from '../src/application/billing/billing.js';
import { createWalletApi } from '../src/application/wallet/wallet.js';
import { createInMemoryWalletStore } from '../src/testing/in-memory-wallet-store.js';
import { createInMemoryBillingWorld } from '../src/testing/in-memory-billing-store.js';
import type { BillingRequestRow } from '../src/ports/billing-store.js';
import { defined } from './defined.js';

function seedDeadRequest(
  world: ReturnType<typeof createInMemoryBillingWorld>,
  input: { requestId: string; userId?: number; revision?: number; reservedAmount?: string },
): void {
  const row: BillingRequestRow = {
    requestId: input.requestId,
    userId: input.userId ?? 42,
    apiKeyId: null,
    channelId: null,
    channelReservedAmount: null,
    planReservedAmount: null,
    subscriptionId: null,
    estimatedExposureAmount: null,
    reservedAmount: input.reservedAmount ?? '5',
    status: 'dead',
    revision: input.revision ?? 3,
    stream: false,
    quote: {},
    authorizationFingerprint: 'fp',
    traceParent: null,
    receipt: null,
    receiptFingerprint: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    failureCode: 'billing.poison_receipt',
    settlementAttempts: 3,
    nextSettlementAt: null,
    claimOwner: null,
    claimToken: null,
    claimUntil: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
  };
  world.fixtures.requests.set(input.requestId, row);
}

function harness() {
  const walletMemory = createInMemoryWalletStore();
  const wallet = createWalletApi({
    store: walletMemory.store,
    guards: {
      refTypes: ['billing', 'admin'],
      currencies: ['CNY'],
      internalAccounts: ['outside', 'platform_revenue'],
    },
    currency: 'CNY',
  });
  const world = createInMemoryBillingWorld();
  const fundingRegistry = createDefaultFundingRegistry({
    wallet,
    walletStore: walletMemory.store,
    store: world.billing,
    quota: world.quota,
  });
  const auditTx = vi.fn(async () => {});
  const settlement = createSettlementApi({
    store: world.billing,
    walletStore: walletMemory.store,
    fundingRegistry,
    channels: world.channels,
    usageDefectBreaker: 5,
    failurePolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
    clock: () => new Date('2026-08-23T00:00:00Z'),
    onError: () => {},
    reviewAuditTx: auditTx,
  });
  return { settlement, world, auditTx, walletMemory, wallet };
}

describe('SettlementApi.review（U6）', () => {
  it('listDead:dead 专属投影(其余状态不入面)', async () => {
    const { settlement, world } = harness();
    seedDeadRequest(world, { requestId: '00000000-0000-4000-8000-000000000001' });
    seedDeadRequest(world, { requestId: '00000000-0000-4000-8000-000000000002' });
    defined(world.fixtures.requests.get('00000000-0000-4000-8000-000000000002')).status = 'settled';

    const page = await settlement.review.listDead({ limit: 10, offset: 0 });
    expect(page.total).toBe(1);
    expect(page.rows[0]).toMatchObject({
      requestId: '00000000-0000-4000-8000-000000000001',
      status: 'dead',
      revision: 3,
      failureCode: 'billing.poison_receipt',
    });
  });

  it('retry:CAS dead→retry_wait 清失败态;乐观锁不符 → state_conflict;命令守卫', async () => {
    const { settlement, world, auditTx } = harness();
    const requestId = '00000000-0000-4000-8000-00000000000a';
    seedDeadRequest(world, { requestId });

    const result = await settlement.review.retryDead({
      requestId,
      expectedRevision: 3,
      reason: '上游恢复,重试结算',
      adminId: 7,
      operationId: 'rv-1',
    });
    expect(result).toMatchObject({ requestId, status: 'retry_wait', replayed: false, revision: 4 });
    const row = defined(world.fixtures.requests.get(requestId));
    expect(row.status).toBe('retry_wait');
    expect(row.failureCode).toBeNull();
    expect(row.settlementAttempts).toBe(0);
    expect(auditTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'billing.retry_dead', adminId: 7, targetId: requestId }),
    );

    // 乐观锁:旧 revision 再试 → 409 语义
    await expect(
      settlement.review.retryDead({
        requestId,
        expectedRevision: 3,
        reason: 'stale view',
        adminId: 7,
        operationId: 'rv-2',
      }),
    ).rejects.toMatchObject({ code: 'billing.state_conflict' });

    // 命令守卫:空理由/超长理由 → invalid_review_command
    await expect(
      settlement.review.retryDead({
        requestId,
        expectedRevision: 4,
        reason: '  ',
        adminId: 7,
        operationId: 'rv-3',
      }),
    ).rejects.toMatchObject({ code: 'billing.invalid_review_command' });
  });

  it('幂等:同 operationId 同参重放回执;异参 → idempotency_conflict', async () => {
    const { settlement, world } = harness();
    const requestId = '00000000-0000-4000-8000-00000000000b';
    seedDeadRequest(world, { requestId, revision: 1 });

    const command = {
      requestId,
      expectedRevision: 1,
      reason: '复核重试',
      adminId: 7,
      operationId: 'rv-replay',
    } as const;
    const first = await settlement.review.retryDead({ ...command });
    expect(first.replayed).toBe(false);
    // 重放:请求已离开 dead——CAS 不再命中,但 operations 档案先行回执重放
    const replay = await settlement.review.retryDead({ ...command });
    expect(replay.replayed).toBe(true);
    expect(replay).toMatchObject({ requestId, status: 'retry_wait' });

    await expect(
      settlement.review.retryDead({ ...command, reason: '不同理由' }),
    ).rejects.toMatchObject({ code: 'billing.idempotency_conflict' });
  });

  it('abandon:CAS dead→released + 释放路径执行 + 审计;乐观锁不符 → state_conflict', async () => {
    const { settlement, world, auditTx, wallet } = harness();
    const requestId = '00000000-0000-4000-8000-00000000000c';
    seedDeadRequest(world, { requestId, revision: 2, reservedAmount: '5' });
    // 预扣事实三件:入金 + 钱包冻结单(authorize)+ 明细真相行(加总 = 总预扣)
    await wallet.credit({ userId: 42, amount: '10', refType: 'admin', refId: `seed-${requestId}` });
    await wallet.authorize({
      userId: 42,
      amount: '5',
      refType: 'billing',
      refId: requestId,
    });
    await world.billing.transaction((tx) =>
      world.billing.insertReservation(tx, {
        billingRequestId: requestId,
        sourceType: 'payg',
        sourceRefId: null,
        amount: '5',
      }),
    );

    const result = await settlement.review.abandonDead({
      requestId,
      expectedRevision: 2,
      reason: '上游永久失败,弃单归还',
      evidenceRefs: ['ticket-123'],
      adminId: 7,
      operationId: 'ab-1',
    });
    expect(result).toMatchObject({ requestId, released: true, replayed: false });
    expect(defined(world.fixtures.requests.get(requestId)).status).toBe('released');
    expect(auditTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'billing.abandon_dead', targetId: requestId }),
    );

    await expect(
      settlement.review.abandonDead({
        requestId: '00000000-0000-4000-8000-0000000000ff',
        expectedRevision: 0,
        reason: '不存在',
        adminId: 7,
        operationId: 'ab-2',
      }),
    ).rejects.toMatchObject({ code: 'billing.state_conflict' });
  });
});
