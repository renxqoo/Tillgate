/**
 * 结算管线契约测试（内存 stand-in；迁移自旧仓 service/__tests__/settlement*.test.ts
 * 主干；真实 PG 的 SKIP LOCKED/租约/五元组竞态在 settlement-lifecycle.real.test.ts）。
 */
import { describe, expect, it } from 'vitest';
import { createWalletApi } from '../src/application/wallet/wallet.js';
import { createBillingApi } from '../src/application/billing/billing.js';
import { createSettlementApi } from '../src/application/settlement/settlement.js';
import { createDefaultFundingRegistry } from '../src/application/billing/billing.js';
import { createInMemoryWalletStore } from '../src/testing/in-memory-wallet-store.js';
import { seedChannel } from '../src/testing/in-memory-billing-store.js';
import { createInMemoryBillingWorld } from '../src/testing/in-memory-billing-store.js';
import type { UsageReceipt } from '../src/domain/rating/types.js';

let userSeq = 900;
let reqSeq = 0;
const nextUser = () => (userSeq += 1);
const nextRequestId = () => {
  const n = (reqSeq += 1);
  const hex = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}${'0'.repeat(12 - hex.length)}`.slice(0, 36);
};

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
  const store = world.billing;
  const fundingRegistry = createDefaultFundingRegistry({
    wallet,
    walletStore: walletMemory.store,
    store,
    quota: world.quota,
  });
  const billing = createBillingApi({
    store,
    resolver: world.resolver,
    quota: world.quota,
    channels: world.channels,
    walletStore: walletMemory.store,
    wallet,
    currency: 'CNY',
  });
  const settlement = createSettlementApi({
    store,
    walletStore: walletMemory.store,
    fundingRegistry,
    channels: world.channels,
    failurePolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
  });
  return { wallet, walletMemory, world, billing, settlement };
}

function receiptFor(
  requestId: string,
  userId: number,
  overrides: Partial<UsageReceipt> = {},
): UsageReceipt {
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
    ...overrides,
  };
}

/** 全链推进到 settlement_pending（authorize → signal succeeded） */
async function toPending(h: ReturnType<typeof harness>, inputTokens = 1_000_000) {
  const userId = nextUser();
  await h.wallet.credit({ userId, amount: '10', refType: 'topup', refId: `s-${userId}` });
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
    receipt: receiptFor(requestId, userId, {
      usage: { inputTokens, cachedInputTokens: 0, outputTokens: 0, estimated: false },
    }),
  });
  return { userId, requestId };
}

describe('结算管线（claim → settle）', () => {
  it('全额结算：认领→落定（钱包扣减/在途归零/usage 投影/CAS settled）', async () => {
    const h = harness();
    const { userId, requestId } = await toPending(h); // 实扣 2（1M×2/1M）
    const [claim] = await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
    expect(claim!.requestId).toBe(requestId);
    const result = await h.settlement.processClaim(claim!);
    expect(result).toBe('settled');
    const account = (await h.wallet.accounts(userId))[0]!;
    expect(account.balance).toBe('8');
    expect(account.inFlight).toBe('0');
    const row = h.world.fixtures.requests.get(requestId)!;
    expect(row.status).toBe('settled');
    const usage = h.world.fixtures.usageLogs.get(requestId)!;
    expect(usage.calculatedAmount).toBe('2');
    expect(usage.billedBy).toBe('payg');
  });

  it('部分结算 + 幂等回查：认领失效时 usage_logs 判 already_settled', async () => {
    const h = harness();
    const { userId } = await toPending(h, 250_000); // 实扣 0.5（预留 2）
    const [claim] = await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
    const outcome = await h.settlement.processClaim(claim!);
    expect(outcome).toBe('settled');
    expect((await h.wallet.accounts(userId))[0]!.balance).toBe('9.5');
    // 认领失效 + usage_logs 已有记录 → already_settled（幂等返回首笔金额）
    const stale = { ...claim!, claimToken: 'ghost' };
    const result = await h.settlement.settleClaim(stale);
    expect(result).toMatchObject({ outcome: 'already_settled', amount: '0.5' });
    // 无 usage 记录的失效认领才是 claim_lost
    const orphan = await h.settlement.settleClaim({
      ...stale,
      requestId: '00000000-0000-4000-8000-00000000dead',
    });
    expect(orphan.outcome).toBe('claim_lost');
  });

  it('0 元结算：走全额释放（不落死信家族）', async () => {
    const h = harness();
    const { userId, requestId } = await toPending(h, 0); // 全免 usage
    const [claim] = await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
    const outcome = await h.settlement.processClaim(claim!);
    expect(outcome).toBe('settled');
    const account = (await h.wallet.accounts(userId))[0]!;
    expect(account.balance).toBe('10');
    expect(account.inFlight).toBe('0');
    expect(h.world.fixtures.requests.get(requestId)!.status).toBe('settled');
  });

  it('毒收据：死信（不重试）——B3 家族经结算管线分型', async () => {
    const h = harness();
    const { requestId } = await toPending(h);
    // 篡改收据价格为垃圾串 → decode 守卫毒收据 → dead
    const row = h.world.fixtures.requests.get(requestId)!;
    row.receipt = { ...row.receipt, inputPrice: 'garbage' };
    const [claim] = await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
    const outcome = await h.settlement.processClaim(claim!);
    expect(outcome).toBe('dead');
    expect(h.world.fixtures.requests.get(requestId)!.status).toBe('dead');
  });

  it('瞬态失败：退避重试（retry_wait + 退避时间），再领成功', async () => {
    const h = harness();
    const { requestId } = await toPending(h);
    const [claim] = await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
    // 瞬态失败直驱失败处置（普通 Error 不属死信家族）→ retried + retry_wait
    const retried = await (
      await import('../src/application/settlement/failure.js')
    ).createFailureUseCase({
      store: h.world.billing,
      policy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
    })(claim!, new Error('ECONNRESET'));
    expect(retried).toBe('retried');
    const row = h.world.fixtures.requests.get(requestId)!;
    expect(row.status).toBe('retry_wait');
    // 重领后完整结算
    const [claim2] = await h.settlement.claim({
      ownerId: 'w2',
      batchSize: 10,
      claimLeaseMs: 5_000,
    });
    expect(claim2!.requestId).toBe(requestId);
    expect(await h.settlement.processClaim(claim2!)).toBe('settled');
  });
});

describe('恢复三路径', () => {
  it('authorized 过期未发上游 → released（预占归还）；in_flight 租约过期 → released', async () => {
    const h = harness();
    // ①：授权后放任租约过期
    const userIdA = nextUser();
    await h.wallet.credit({ userId: userIdA, amount: '10', refType: 'topup', refId: 'r1' });
    const requestIdA = nextRequestId();
    await h.billing.authorize({
      requestId: requestIdA,
      userId: userIdA,
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
      authorizationTtlMs: -1, // 立即过期
    });
    // ②：in_flight 租约过期
    const userIdB = nextUser();
    await h.wallet.credit({ userId: userIdB, amount: '10', refType: 'topup', refId: 'r2' });
    const requestIdB = nextRequestId();
    await h.billing.authorize({
      requestId: requestIdB,
      userId: userIdB,
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
      authorizationTtlMs: -1,
    });
    await h.billing.signal({
      type: 'upstream.started',
      requestId: requestIdB,
      leaseOwner: 'g',
      leaseMs: -1,
    });
    const result = await h.settlement.recover({ batchSize: 10 });
    expect(result.released).toBe(2);
    expect((await h.wallet.accounts(userIdA))[0]!.inFlight).toBe('0');
    expect((await h.wallet.accounts(userIdB))[0]!.inFlight).toBe('0');
    expect(h.world.fixtures.requests.get(requestIdA)!.status).toBe('released');
  });

  it('processing 认领租约过期 → retry_wait 可重领（再走完整结算）', async () => {
    const h = harness();
    const { requestId } = await toPending(h);
    const [claim] = await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
    // 模拟 worker 崩溃：租约过期 → requeue → retry_wait 可重领
    h.world.fixtures.requests.get(requestId)!.claimUntil = new Date(Date.now() - 1);
    const requeued = await h.world.billing.transaction((tx) =>
      h.world.billing.requeueExpiredClaims(tx, 10),
    );
    expect(requeued).toBe(1);
    expect(h.world.fixtures.requests.get(requestId)!.status).toBe('retry_wait');
    const [reclaim] = await h.settlement.claim({
      ownerId: 'w2',
      batchSize: 10,
      claimLeaseMs: 5_000,
    });
    expect(reclaim!.requestId).toBe(requestId);
    void claim;
  });

  it('abandonOwnedClaims：优雅停机归还本副本认领', async () => {
    const h = harness();
    const { requestId } = await toPending(h);
    await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 60_000 });
    expect(h.world.fixtures.requests.get(requestId)!.status).toBe('processing');
    const returned = await h.settlement.abandonOwnedClaims('w1');
    expect(returned).toBe(1);
    expect(h.world.fixtures.requests.get(requestId)!.status).toBe('retry_wait');
  });
});

describe('对账核验', () => {
  it('健康账本零违规；余额漂移被检出（account_balance）', async () => {
    const h = harness();
    const { userId } = await toPending(h);
    const report = await h.settlement.verifyInvariants();
    expect(report.ok).toBe(true);
    // 直接改钱包余额制造漂移（绕过动词——运维事故模拟）
    h.walletMemory.defaceBalanceForTest(userId, 'CNY', '999');
    const broken = await h.settlement.verifyInvariants();
    expect(broken.ok).toBe(false);
    expect(broken.violations.some((v) => v.kind === 'account_balance')).toBe(true);
  });
});

describe('结算渠道链路与钩子', () => {
  it('渠道敞口随结算归还 + 进货额度按 upstreamCost 扣减；预算击穿触发熔断', async () => {
    const h = harness();
    const channelId = seedChannel(h.world, { upstreamBudget: '2', upstreamThreshold: '0.5' });
    // 授权后、signal 前认领渠道（settlement_pending 后不可再认领）
    const userId = nextUser();
    await h.wallet.credit({ userId, amount: '10', refType: 'topup', refId: `ch-${userId}` });
    const requestId = nextRequestId();
    const quote = {
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
    };
    await h.billing.authorize({
      requestId,
      userId,
      stream: false,
      quote,
      reservationLimit: '10',
      authorizationTtlMs: 60_000,
    });
    await h.billing.reserveChannel({ requestId, channelId, amount: '2' });
    expect(h.world.fixtures.channelsMap.get(channelId)!.upstreamReserved).toBe('2');
    await h.billing.signal({
      type: 'request.succeeded',
      requestId,
      receipt: receiptFor(requestId, userId),
    });
    const [claim] = await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
    const result = await h.settlement.settleClaim(claim!);
    expect(result).toMatchObject({ outcome: 'settled', channelCircuitBroken: true });
    // 敞口归还 + 预算扣减（2 − 2 = 0 ≤ 阈值 0.5 → 熔断）
    expect(h.world.fixtures.channelsMap.get(channelId)!.upstreamReserved).toBe('0');
    expect(h.world.fixtures.channelsMap.get(channelId)!.status).toBe(3);
    void userId;
  });

  it('结算归属校验：收据 userId 与账单错配 → receipt_user_mismatch → dead', async () => {
    const h = harness();
    const { requestId } = await toPending(h);
    const row = h.world.fixtures.requests.get(requestId)!;
    row.receipt = { ...row.receipt!, userId: 424242 };
    const [claim] = await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
    const outcome = await h.settlement.processClaim(claim!);
    expect(outcome).toBe('dead');
    expect(h.world.fixtures.requests.get(requestId)!.status).toBe('dead');
  });

  it('onSettled 钩子：事务后携金额触发；钩子异常不反杀结算', async () => {
    let observed: { requestId: string; amount: string } | undefined;
    const h = harness();
    const settlement = createSettlementApi({
      store: h.world.billing,
      walletStore: h.walletMemory.store,
      fundingRegistry: createDefaultFundingRegistry({
        wallet: h.wallet,
        walletStore: h.walletMemory.store,
        store: h.world.billing,
        quota: h.world.quota,
      }),
      channels: h.world.channels,
      failurePolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
      onSettled: (data) => {
        observed = { requestId: data.requestId, amount: data.amount };
        throw new Error('hook exploded');
      },
    });
    const { requestId } = await toPending(h);
    const [claim] = await settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
    const outcome = await settlement.processClaim(claim!);
    expect(outcome).toBe('settled');
    expect(observed).toEqual({ requestId, amount: '2' });
  });

  it('recover 毒行隔离：投影脱节行只损失自己，不阻塞其他滞留单归还', async () => {
    const h = harness();
    // 两笔过期授权：一笔正常，一笔明细被篡改（Σ明细 ≠ 总预扣 → releaseAll 红灯）
    const ids: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const userId = nextUser();
      await h.wallet.credit({ userId, amount: '10', refType: 'topup', refId: `px-${userId}` });
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
        authorizationTtlMs: -1,
      });
      ids.push(requestId);
    }
    // 篡改第一笔的总预扣（制造明细脱节）
    h.world.fixtures.requests.get(ids[0]!)!.reservedAmount = '999';
    const errors: string[] = [];
    const recoverResult = await (
      await import('../src/application/settlement/recover.js')
    ).createRecoverUseCase({
      store: h.world.billing,
      fundingRegistry: createDefaultFundingRegistry({
        wallet: h.wallet,
        walletStore: h.walletMemory.store,
        store: h.world.billing,
        quota: h.world.quota,
      }),
      onError: (error, ctx) => errors.push(ctx),
    })({ batchSize: 10 });
    expect(recoverResult.released).toBe(1); // 毒行被隔离，健康行归还
    expect(errors.length).toBeGreaterThan(0);
    expect(h.world.fixtures.requests.get(ids[1]!)!.status).toBe('released');
  });
});

describe('分支封口补充', () => {
  it('processClaim 的 claim_lost 映射；claim 的 requestIds 定向过滤', async () => {
    const h = harness();
    const a = await toPending(h);
    const b = await toPending(h);
    const claims = await h.settlement.claim({
      ownerId: 'w1',
      batchSize: 10,
      claimLeaseMs: 5_000,
      requestIds: [a.requestId],
    });
    expect(claims.map((c) => c.requestId)).toEqual([a.requestId]);
    // 五元组失配且无 usage 记录 → claim_lost 经 processClaim 映射
    const outcome = await h.settlement.processClaim({
      requestId: b.requestId,
      ownerId: 'nobody',
      claimToken: 'ghost',
      revision: 0,
      attempt: 1,
      receipt: b ? h.world.fixtures.requests.get(b.requestId)!.receipt : null,
      traceParent: null,
    });
    expect(outcome).toBe('claim_lost');
  });

  it('signal.failed 归还渠道敞口（三路释放含渠道）', async () => {
    const h = harness();
    const channelId = seedChannel(h.world, { upstreamBudget: '10' });
    const userId = nextUser();
    await h.wallet.credit({ userId, amount: '10', refType: 'topup', refId: `sf-${userId}` });
    const requestId = nextRequestId();
    const quote = {
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
    };
    await h.billing.authorize({
      requestId,
      userId,
      stream: false,
      quote,
      reservationLimit: '10',
      authorizationTtlMs: 60_000,
    });
    await h.billing.reserveChannel({ requestId, channelId, amount: '2' });
    expect(h.world.fixtures.channelsMap.get(channelId)!.upstreamReserved).toBe('2');
    const released = await h.billing.signal({ type: 'request.failed', requestId, reason: 'x' });
    expect(released).toMatchObject({ changed: true, amountReleased: '2' });
    expect(h.world.fixtures.channelsMap.get(channelId)!.upstreamReserved).toBe('0');
  });

  it('failure 的 onDead 钩子：死信时触发一次', async () => {
    const dead: string[] = [];
    const h = harness();
    const { requestId } = await toPending(h);
    const row = h.world.fixtures.requests.get(requestId)!;
    row.receipt = { ...row.receipt!, inputPrice: 'garbage' };
    const [claim] = await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
    const settlement = createSettlementApi({
      store: h.world.billing,
      walletStore: h.walletMemory.store,
      fundingRegistry: createDefaultFundingRegistry({
        wallet: h.wallet,
        walletStore: h.walletMemory.store,
        store: h.world.billing,
        quota: h.world.quota,
      }),
      failurePolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
      onDead: (data) => dead.push(data.requestId),
    });
    // 该认领已被上一 settlement 持有——直接用失败处置走 dead 分支
    const outcome = await (
      await import('../src/application/settlement/failure.js')
    ).createFailureUseCase({
      store: h.world.billing,
      policy: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 1_000 },
      onDead: (data) => dead.push(data.requestId),
    })(claim!, new Error('boom'));
    expect(outcome).toBe('dead');
    expect(dead).toEqual([requestId]);
    void settlement;
  });
});

describe('U4 补：claim 辅助分支', () => {
  it('renewClaims 空令牌集零操作；非空续租', async () => {
    const h = harness();
    const { requestId } = await toPending(h);
    await h.settlement.claim({ ownerId: 'w9', batchSize: 10, claimLeaseMs: 60_000 });
    await h.settlement.renewClaims({ ownerId: 'w9', tokens: [], claimLeaseMs: 1000 });
    const token = h.world.fixtures.requests.get(requestId)!.claimToken!;
    await h.settlement.renewClaims({ ownerId: 'w9', tokens: [token], claimLeaseMs: 60_000 });
    expect(h.world.fixtures.requests.get(requestId)!.claimUntil!.getTime()).toBeGreaterThan(
      Date.now() - 1000,
    );
  });
});
