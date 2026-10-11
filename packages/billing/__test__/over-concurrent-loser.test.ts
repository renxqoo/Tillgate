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
    usage: {
      inputTokens: input.inputTokens,
      cachedInputTokens: 0,
      outputTokens: 0,
      estimated: false,
    },
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
  it('同用户两笔并发超冻结：败者守卫失败钳制 waived，零死信（P11 真实构造）', async () => {
    // 真实 gate 失败向量：余额 1、冻结 0.2/笔、实际各 4 元。
    // 胜者：ceiling = (1−0.2)+0(地板) = 0.8 → over 3.8 只收 0.8（首 authorize
    // 成功——旧/新实现同）；败者：ceiling = (1−0.2−0.2−0.8 已收) < 0 →
    // conditionalReserve 守卫输 → 旧实现 DefectError(gate_unclassified) 死信。
    const h = harness('0');
    const userId = nextUser();
    const a = await pendingOverRequest(h, {
      userId,
      frozen: '0.2',
      receiptTokens: 2_000_000,
      balance: '1',
    });
    const b = await pendingOverRequest(h, {
      userId,
      frozen: '0.2',
      receiptTokens: 2_000_000,
      balance: '1',
    });
    const claims = await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
    expect(claims).toHaveLength(2);
    const [ra, rb] = await Promise.all([
      h.settlement.processClaim(defined(claims[0])),
      h.settlement.processClaim(defined(claims[1])),
    ]);
    // 两笔都 settled（败者钳制/全额 waived），零 dead
    expect(ra).toBe('settled');
    expect(rb).toBe('settled');
    for (const requestId of [a, b]) {
      expect(defined(h.world.fixtures.requests.get(requestId)).status).toBe('settled');
    }
  });

  it('守卫失败家族精确性：非 gate 错误上抛（连接错误不当守卫失败吞掉）', async () => {
    const mod = await import('../src/application/billing/funding/payg-source.js');
    // payg-source 不导出 isOverageGuardFailure（模块私有）——经 settleOverage 行为验证：
    // 构造 wallet 抛连接错误（非 gate），断言上抛而非 waived
    const wallet = {
      authorize: async () => {
        throw new Error('connection unavailable (pool exhausted)');
      },
      settle: async () => {
        throw new Error('unreachable');
      },
    };
    const walletStore = {
      userAccountSummaries: async () => [
        {
          id: 1,
          kind: 'user',
          currency: 'CNY',
          balance: '10',
          inFlight: '0',
          creditLimit: '0',
          debitFloor: '0',
          status: 'active',
        },
      ],
    };
    // settleOverage 也模块私有——经 createPaygSource().settle 驱动
    const source = mod.createPaygSource({
      wallet: wallet as never,
      walletStore: walletStore as never,
    });
    await expect(
      source.settle(undefined as never, {
        userId: 1,
        requestId: 'r-conn',
        reservation: {
          billingRequestId: 'r-conn',
          sourceType: 'payg',
          sourceRefId: null,
          amount: '0.2',
        },
        consume: '0.2',
        over: '3.8',
        now: new Date(),
      }),
    ).rejects.toThrow('connection unavailable');
  });

  it('F1#1：两次守卫失败 → collectOver 归零、waived=全额（不虚收）', async () => {
    // 直接单元驱动 settleOverage 行为：wallet 连续输守卫，实收 0、waived=over 全额
    const mod = await import('../src/application/billing/funding/payg-source.js');
    let authorizeCalls = 0;
    const wallet = {
      authorize: async () => {
        authorizeCalls += 1;
        const { DefectError } = await import('@tillgate/errors');
        throw new DefectError('authorize.gate_unclassified', 'billing.wallet_invariant');
      },
      // consume 腿（#over 前）正常走；over 段的 settle 若被调用说明守卫失败没拦住
      settle: async (input: { refId?: string }) => {
        if ((input?.refId ?? '').includes('#over')) {
          throw new Error('over settle must not be reached');
        }
        return {
          authorizationId: 'a',
          settledAmount: '0.2',
          balanceAfter: '9.8',
          releasedRemainder: '0',
          replayed: false,
        };
      },
    };
    const walletStore = {
      userAccountSummaries: async () => [
        {
          id: 1,
          kind: 'user',
          currency: 'CNY',
          balance: '10',
          inFlight: '0',
          creditLimit: '0',
          debitFloor: '0',
          status: 'active',
        },
      ],
    };
    const source = mod.createPaygSource({
      wallet: wallet as never,
      walletStore: walletStore as never,
    });
    const settled = await source.settle(undefined as never, {
      userId: 1,
      requestId: 'r-twice',
      reservation: {
        billingRequestId: 'r-twice',
        sourceType: 'payg',
        sourceRefId: null,
        amount: '0.2',
      },
      consume: '0.2',
      over: '3.8',
      now: new Date(),
    });
    // 修后：waived = 3.8（实收 0 全额放弃）；修前缺陷：waived = 0（虚收 3.8）
    expect(settled.waived).toBe('3.8');
    expect(authorizeCalls).toBe(2); // 首试 + 一次重试
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
