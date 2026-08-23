/**
 * §5.4 可靠通知边界测试（fake outbox + 内存回滚模拟事务壳）：
 *   ①业务回滚 → 无事件；②入箱抛错 → 业务回滚（余额/状态不变）；
 *   ③同 requestId 并发/重试 → dedupe 后单一事件。
 *
 * 内存 stand-in 无回滚语义——rollbackableStore 用双 store 深快照在事务异常时
 * 一并还原（模拟 PG 整事务回滚）；真实 PG 的同事务原子性由
 * settlement-lifecycle.real.test.ts 的同库语义覆盖。
 */
import { describe, expect, it } from 'vitest';
import { createWalletApi } from '../src/application/wallet/wallet.js';
import {
  createBillingApi,
  createDefaultFundingRegistry,
} from '../src/application/billing/billing.js';
import { createSettlementApi } from '../src/application/settlement/settlement.js';
import { createSettleClaimUseCase } from '../src/application/settlement/settle.js';
import { createFailureUseCase } from '../src/application/settlement/failure.js';
import { createInMemoryWalletStore } from '../src/testing/in-memory-wallet-store.js';
import { createInMemoryBillingWorld } from '../src/testing/in-memory-billing-store.js';
import type { BillingStore } from '../src/ports/billing-store.js';
import type { NotificationOutboxPort, OutboxFact } from '../src/ports/notification-outbox.js';
import type { UsageReceipt } from '../src/domain/rating/types.js';
import type { InMemoryBillingWorld } from '../src/testing/in-memory-billing-store.js';

let userSeq = 5000;
let reqSeq = 0;
const nextUser = () => (userSeq += 1);
const nextRequestId = () => {
  const n = (reqSeq += 1);
  const hex = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}${'0'.repeat(12 - hex.length)}`.slice(0, 36);
};

/** §5.4 边界测试专用：双 store 深快照 + 异常还原（模拟 PG 整事务回滚） */
function rollbackableStore(
  world: InMemoryBillingWorld,
  walletMemory: ReturnType<typeof createInMemoryWalletStore>,
): BillingStore {
  const inner = world.billing;
  return {
    ...inner,
    async transaction(fn) {
      const walletSnap = walletMemory.snapshotForTest();
      const worldSnap = world.snapshotForTest();
      try {
        return await inner.transaction(fn);
      } catch (error) {
        walletMemory.restoreForTest(walletSnap);
        world.restoreForTest(worldSnap);
        throw error;
      }
    },
  };
}

/** fake outbox：dedupeKey 唯一索引语义（重复入箱返回 false）；可编程失败 */
function fakeOutbox() {
  const events: OutboxFact[] = [];
  let failAppend = false;
  const port: NotificationOutboxPort = {
    async append(_tx, fact) {
      if (failAppend) throw new Error('outbox insert failed');
      if (events.some((existing) => existing.dedupeKey === fact.dedupeKey)) return false;
      events.push(fact);
      return true;
    },
  };
  return {
    events,
    port,
    failNextAppend() {
      failAppend = true;
    },
  };
}

function harness() {
  const walletMemory = createInMemoryWalletStore();
  const wallet = createWalletApi({
    store: walletMemory.store,
    guards: {
      refTypes: ['billing', 'topup', 'admin'],
      currencies: ['CNY'],
      internalAccounts: ['outside', 'platform_revenue'],
    },
    currency: 'CNY',
  });
  const world = createInMemoryBillingWorld();
  const store = rollbackableStore(world, walletMemory);
  const outbox = fakeOutbox();
  const billing = createBillingApi({
    store,
    resolver: world.resolver,
    quota: world.quota,
    channels: world.channels,
    walletStore: walletMemory.store,
    wallet,
    currency: 'CNY',
    clock: () => new Date(),
  });
  const fundingRegistry = createDefaultFundingRegistry({
    wallet,
    walletStore: walletMemory.store,
    store: world.billing,
    quota: world.quota,
  });
  const settlement = createSettlementApi({
    store,
    walletStore: walletMemory.store,
    fundingRegistry,
    channels: world.channels,
    failurePolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
    clock: () => new Date(),
    onError: () => undefined,
    outbox: outbox.port,
  });
  return { wallet, walletMemory, world, billing, settlement, outbox, store };
}

function receiptFor(requestId: string, userId: number): UsageReceipt {
  return {
    requestId,
    userId,
    apiKeyId: null,
    appId: null,
    credentialType: 'key',
    externalModel: 'm',
    realModel: 'm',
    channelId: null,
    channelKey: 't',
    usage: { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0, estimated: false },
    inputPrice: '2',
    outputPrice: '0',
    cacheInputPrice: '0',
    coefficient: '1',
    durationMs: 10,
    stream: false,
    streamAborted: false,
    mappingId: 1,
    billingPolicyFingerprint: null,
  };
}

/** 全链推进到 processing 认领（authorize → signal succeeded → claim） */
async function toClaimed(h: ReturnType<typeof harness>) {
  const userId = nextUser();
  await h.wallet.credit({ userId, amount: '10', refType: 'topup', refId: `o-${userId}` });
  const requestId = nextRequestId();
  await h.billing.authorize({
    requestId,
    userId,
    stream: false,
    quote: {
      maxOutputTokens: 0,
      candidates: [
        {
          mappingId: 1,
          externalModel: 'm',
          realModel: 'm',
          inputPrice: '2',
          outputPrice: '0',
          cacheInputPrice: '0',
          coefficient: '1',
          inputTokenUpperBound: 1_000_000,
          billingPolicyFingerprint: null,
        },
      ],
    },
    reservationLimit: '10',
    authorizationTtlMs: 60_000,
  });
  await h.billing.signal({
    type: 'request.succeeded',
    requestId,
    receipt: receiptFor(requestId, userId),
  });
  const [claim] = await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
  expect(claim!.requestId).toBe(requestId);
  return { userId, requestId, claim: claim! };
}

describe('§5.4 边界①：业务回滚 → 无事件', () => {
  it('结算事务在入箱前抛错（投影脱节红灯）→ 回滚且 outbox 零事件', async () => {
    const h = harness();
    const { userId, requestId, claim } = await toClaimed(h);
    // 制造业务红灯：Σ明细 ≠ 总预扣（不变量 DefectError）
    h.world.fixtures.requests.get(requestId)!.reservedAmount = '999';
    await expect(h.settlement.settleClaim(claim)).rejects.toThrow();
    expect(h.outbox.events).toHaveLength(0);
    // 业务结果未被提交：认领仍在 processing，钱包在途未消耗
    expect(h.world.fixtures.requests.get(requestId)!.status).toBe('processing');
    const account = (await h.wallet.accounts(userId))[0]!;
    expect(account.inFlight).toBe('2');
    expect(account.balance).toBe('10');
  });
});

describe('§5.4 边界②：入箱抛错 → 业务回滚（余额/状态不变）', () => {
  it('结算成功不入箱（v2 口径）：outbox 故障不影响 settleClaim，事件恒零', async () => {
    const h = harness();
    const { userId, requestId, claim } = await toClaimed(h);
    h.outbox.failNextAppend();
    // billing.settled 非词表成员，结算路径已结构性移除入箱——outbox 故障无接触面
    const result = await h.settlement.settleClaim(claim);
    expect(result.outcome).toBe('settled');
    expect((await h.wallet.accounts(userId))[0]!.balance).toBe('8');
    expect(h.world.fixtures.requests.get(requestId)!.status).toBe('settled');
    expect(h.outbox.events).toHaveLength(0);
  });

  it('死信入箱失败：处置整体回滚（行停留 processing，可由租约恢复重试）', async () => {
    const h = harness();
    const { requestId, claim } = await toClaimed(h);
    h.outbox.failNextAppend();
    const finishFailure = createFailureUseCase({
      store: h.store,
      policy: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 1_000 },
      outbox: h.outbox.port,
    });
    await expect(finishFailure(claim, new Error('boom'))).rejects.toThrow('outbox insert failed');
    expect(h.world.fixtures.requests.get(requestId)!.status).toBe('processing');
    expect(h.outbox.events).toHaveLength(0);
  });
});

describe('§5.4 边界③：同 requestId 并发/重试 → dedupe 后单一事件', () => {
  it('重放双 settle：零入箱事件（结算成功无通知口径的回归锁）', async () => {
    const h = harness();
    const { claim } = await toClaimed(h);
    // 结算/重放均不触 outbox（billing.settled 已结构性移除）；
    // 入箱幂等（dedupeKey 唯一吸收）的路径级覆盖在下方死信用例。
    const first = await h.settlement.settleClaim(claim);
    const replay = await h.settlement.settleClaim(claim);
    expect(first.outcome).toBe('settled');
    expect(replay.outcome).toBe('already_settled');
    expect(h.outbox.events).toHaveLength(0);
  });

  it('死信重投（同 requestId 同 attempt 重放处置）：billing_dead 事件 dedupe 后唯一', async () => {
    const h = harness();
    const { requestId, claim } = await toClaimed(h);
    const finishFailure = createFailureUseCase({
      store: h.store,
      policy: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 1_000 },
      outbox: h.outbox.port,
    });
    expect(await finishFailure(claim, new Error('boom'))).toBe('dead');
    expect(h.outbox.events).toHaveLength(1);
    // 事件名 = notifications NOTIFY_EVENTS 词表成员（点分名会被消费方词表门拒绝）
    expect(h.outbox.events[0]).toMatchObject({ event: 'billing_dead' });
    // 模拟「死信已入箱但处置重放」（如 worker 重投）：行重开 processing 后同键再入箱
    const row = h.world.fixtures.requests.get(requestId)!;
    row.status = 'processing';
    row.claimOwner = claim.ownerId;
    row.claimToken = claim.claimToken;
    row.revision = claim.revision;
    expect(await finishFailure(claim, new Error('boom'))).toBe('dead');
    expect(h.outbox.events).toHaveLength(1); // dedupe 吸收，无第二条
    // attempt 递增（人工复活后再次死信）= 新事实 → 新 dedupeKey
    row.status = 'processing';
    row.claimOwner = claim.ownerId;
    row.claimToken = claim.claimToken;
    row.revision = claim.revision;
    expect(await finishFailure({ ...claim, attempt: claim.attempt + 1 }, new Error('boom'))).toBe(
      'dead',
    );
    expect(h.outbox.events).toHaveLength(2);
    expect(h.outbox.events[1]).toMatchObject({
      dedupeKey: `billing.dead:${requestId}:${claim.attempt + 1}`,
    });
  });
});

describe('未注入 outbox：行为不变（可靠通知是可选增强）', () => {
  it('settleClaim 全链照常落定（零通知副作用）', async () => {
    const h = harness();
    const { userId, requestId, claim } = await toClaimed(h);
    const bare = createSettleClaimUseCase({
      store: h.store,
      fundingRegistry: createDefaultFundingRegistry({
        wallet: h.wallet,
        walletStore: h.walletMemory.store,
        store: h.world.billing,
        quota: h.world.quota,
      }),
      clock: () => new Date(),
    });
    const result = await bare(claim);
    expect(result).toMatchObject({ outcome: 'settled', amount: '2' });
    expect((await h.wallet.accounts(userId))[0]!.balance).toBe('8');
    expect(h.outbox.events).toHaveLength(0);
    void requestId;
  });
});
