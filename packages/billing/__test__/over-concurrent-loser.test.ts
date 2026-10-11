/**
 * F1 回归测试（docs §4.3/裁决 D17——先红后绿）：
 * #over 补充授权的并发败者不得走 DefectError 死信——同用户两笔并发结算
 * 同时超冻结，胜者占走地板，败者旧实现抛 authorize.gate_unclassified
 * （死信家族 → 用户全免 + 渠道不扣 + 上游真金已付）。
 * 修复语义：payg-source over 分支捕获守卫失败 → 重读天花板 → 钳到新值，
 * 差额 waived，结算恒成功。
 */
import { describe, expect, it } from 'vitest';
import { createSettlementApi } from '../src/application/settlement/settlement.js';
import { createDefaultFundingRegistry } from '../src/application/billing/billing.js';
import { createWalletApi } from '../src/application/wallet/wallet.js';
import { createInMemoryWalletStore } from '../src/testing/in-memory-wallet-store.js';
import { createInMemoryBillingWorld, seedChannel } from '../src/testing/in-memory-billing-store.js';
import type { UsageReceipt } from '../src/domain/rating/types.js';
import { defined } from './defined.js';

let userSeq = 8100;
let reqSeq = 0;
const nextUser = () => (userSeq += 1);
const nextRequestId = () => {
  const n = (reqSeq += 1);
  const hex = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}${'0'.repeat(12 - hex.length)}`.slice(0, 36);
};

interface OverWorld {
  world: ReturnType<typeof createInMemoryBillingWorld>;
  walletApi: ReturnType<typeof createWalletApi>;
  settlement: ReturnType<typeof createSettlementApi>;
  channelId: number;
}

function harness(debitFloor: string): OverWorld {
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
  const fundingRegistry = createDefaultFundingRegistry({
    wallet,
    walletStore: walletMemory.store,
    store: world.billing,
    quota: world.quota,
  });
  const channelId = seedChannel(world, { upstreamBudget: '1000' });
  const settlement = createSettlementApi({
    store: world.billing,
    walletStore: walletMemory.store,
    fundingRegistry,
    channels: world.channels,
    usageDefectBreaker: 5,
    failurePolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    clock: () => new Date(),
    onError: () => {},
  });
  void debitFloor;
  return { world, walletApi: wallet, settlement, channelId };
}

function receiptOf(input: {
  requestId: string;
  userId: number;
  channelId: number;
  inputTokens: number;
}): UsageReceipt {
  return {
    requestId: input.requestId,
    userId: input.userId,
    apiKeyId: null,
    appId: null,
    credentialType: 'key',
    externalModel: 'm',
    realModel: 'm',
    channelId: input.channelId,
    channelKey: 'ch',
    usage: { inputTokens: input.inputTokens, cachedInputTokens: 0, outputTokens: 0, estimated: false },
    inputPrice: '2',
    outputPrice: '0',
    cacheInputPrice: '0',
    coefficient: '1',
    durationMs: 10,
    stream: false,
    streamAborted: false,
    mappingId: 13,
    billingPolicyFingerprint: null,
  };
}

/** 授权（小额冻结）+ 渠道预留 + settlement_pending + 明细 */
async function pendingOverRequest(
  h: OverWorld,
  input: { userId: number; frozen: string; receiptTokens: number; balance?: string },
): Promise<string> {
  const { world, channelId } = h;
  const requestId = nextRequestId();
  const now = new Date();
  await h.walletApi.credit({
    userId: input.userId,
    amount: input.balance ?? '10',
    refType: 'topup',
    refId: `f-${requestId}`,
  });
  await h.walletApi.authorize({
    userId: input.userId,
    amount: input.frozen,
    currency: 'CNY',
    refType: 'billing',
    refId: requestId,
    memo: `over ${requestId}`,
  });
  await world.billing.insertAuthorized(undefined as never, {
    requestId,
    userId: input.userId,
    apiKeyId: null,
    estimatedExposureAmount: input.frozen,
    reservedAmount: input.frozen,
    planReservedAmount: null,
    subscriptionId: null,
    stream: false,
    quote: {
      maxOutputTokens: 0,
      candidates: [
        {
          mappingId: 13,
          externalModel: 'm',
          realModel: 'm',
          inputPrice: '2',
          outputPrice: '0',
          cacheInputPrice: '0',
          coefficient: '1',
          inputTokenUpperBound: 10_000_000,
          billingPolicyFingerprint: null,
        },
      ],
    },
    authorizationFingerprint: `fp-${requestId}`,
    traceParent: null,
    leaseExpiresAt: new Date(now.getTime() + 60_000),
    nextSettlementAt: now,
    createdAt: now,
  });
  await world.billing.casClaimChannel(undefined as never, {
    requestId,
    fromStatus: ['authorized', 'in_flight'],
    expectedChannelId: null,
    expectedReserved: null,
    channelId,
    channelReservedAmount: '10', // 渠道预留充足（10 ≥ 实际 4——不触发 B4）
    now,
  });
  const ch = defined(world.fixtures.channelsMap.get(channelId));
  ch.upstreamReserved = String(Number(ch.upstreamReserved) + 10);
  await world.billing.casTransition(undefined as never, {
    requestId,
    from: ['authorized'],
    to: 'settlement_pending',
    set: {
      receipt: receiptOf({
        requestId,
        userId: input.userId,
        channelId,
        inputTokens: input.receiptTokens,
      }) as unknown as Record<string, unknown>,
    },
  });
  await world.billing.transaction(async (tx) => {
    await world.billing.insertReservation(tx, {
      billingRequestId: requestId,
      sourceType: 'payg',
      sourceRefId: null,
      amount: input.frozen,
    });
  });
  return requestId;
}

describe('F1：#over 并发败者不死信（先红后绿）', () => {
  it('同用户两笔并发超冻结：败者钳新天花板 waived，零死信', async () => {
    const h = harness('2'); // debit_floor = 2
    const userId = nextUser();
    // 冻结 0.2/笔；实际各 4 元 → 两笔 over 各 ~3.8；可用 10 + 地板 2 = 12 <
    // 8 + 0.4 → 第二笔 over 只能收到部分（钳制）——旧实现败者死信
    const a = await pendingOverRequest(h, { userId, frozen: '0.2', receiptTokens: 2_000_000 });
    const b = await pendingOverRequest(h, { userId, frozen: '0.2', receiptTokens: 2_000_000 });
    const claims = await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
    expect(claims).toHaveLength(2);
    const [ra, rb] = await Promise.all([
      h.settlement.processClaim(defined(claims[0])),
      h.settlement.processClaim(defined(claims[1])),
    ]);
    // 修复后：两笔都 settled（败者 waived），零 dead
    expect(ra).toBe('settled');
    expect(rb).toBe('settled');
    for (const requestId of [a, b]) {
      expect(defined(h.world.fixtures.requests.get(requestId)).status).toBe('settled');
    }
  });

  it('可用+地板不足的 over 差额 waived_amount 落账（单笔口径）', async () => {
    const h = harness('2');
    const userId = nextUser();
    const requestId = await pendingOverRequest(h, {
      userId,
      frozen: '0.2',
      receiptTokens: 4_000_000, // 用户侧 8 元；可用 1−0.2=0.8、地板 0 → over 7.8 只收 0.8
      balance: '1',
    });
    const [claim] = await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
    const outcome = await h.settlement.processClaim(defined(claim));
    expect(outcome).toBe('settled');
    const row = defined(h.world.fixtures.requests.get(requestId));
    expect(row.status).toBe('settled');
    // 钳制 waived：实收 = 0.2 冻结 + 0.8 可收 = 1.0（7 元放弃）
    expect(defined(h.world.fixtures.usageLogs.get(requestId)).calculatedAmount).toBe('1');
  });
});
