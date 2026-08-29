/**
 * 结算管线契约测试（内存 stand-in；真实 PG 的 SKIP LOCKED/租约/五元组竞态在
 * settlement-lifecycle.real.test.ts）。
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
import { defined } from './defined.js';

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
    clock: () => new Date(),
  });
  const errors: string[] = [];
  const settlement = createSettlementApi({
    onDead: (data) => {
      errors.push(`dead ${data.requestId}: ${data.lastError}`);
    },
    store,
    walletStore: walletMemory.store,
    fundingRegistry,
    channels: world.channels,
    usageDefectBreaker: 5,
    failurePolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
    clock: () => new Date(),
    onError: (error, context) => {
      errors.push(`${context}: ${String(error).slice(0, 300)}`);
    },
  });
  return { wallet, walletMemory, world, billing, settlement, errors };
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
async function toPending(
  h: ReturnType<typeof harness>,
  inputTokens = 1_000_000,
  opts: {
    inputUpper?: number;
    reservationPolicy?: { mode: 'full' } | { mode: 'fixed'; amount: string };
    reservationLimit?: string;
  } = {},
) {
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
          inputTokenUpperBound: opts.inputUpper ?? 1_000_000,
          billingPolicyFingerprint: null,
        },
      ],
    },
    ...(opts.reservationPolicy !== undefined ? { reservationPolicy: opts.reservationPolicy } : {}),
    reservationLimit: opts.reservationLimit ?? '10',
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
    expect(defined(claim).requestId).toBe(requestId);
    const result = await h.settlement.processClaim(defined(claim));
    expect(result).toBe('settled');
    const account = defined((await h.wallet.accounts(userId))[0]);
    expect(account.balance).toBe('8');
    expect(account.inFlight).toBe('0');
    const row = defined(h.world.fixtures.requests.get(requestId));
    expect(row.status).toBe('settled');
    const usage = defined(h.world.fixtures.usageLogs.get(requestId));
    expect(usage.calculatedAmount).toBe('2');
    expect(usage.billedBy).toBe('payg');
  });

  it('发票超准入界 → 钳定结算 + usage_clamps 落「发票→验收」轨迹', async () => {
    const h = harness();
    // 准入界 100、发票 1M → 钳到 100；实扣 0.0002（100×2 元/1M）
    const { userId, requestId } = await toPending(h, 1_000_000, { inputUpper: 100 });
    const [claim] = await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
    expect(await h.settlement.processClaim(defined(claim))).toBe('settled');
    const usage = defined(h.world.fixtures.usageLogs.get(requestId));
    expect(usage.inputTokens).toBe(100);
    expect(usage.usageClamps).toEqual([
      { kind: 'input_bound', field: 'inputTokens', original: 1_000_000, clamped: 100, bound: 100 },
    ]);
    expect(usage.calculatedAmount).toBe('0.0002');
    expect(defined((await h.wallet.accounts(userId))[0]).balance).toBe('9.9998');
  });

  it('部分结算 + 幂等回查：认领失效时 usage_logs 判 already_settled', async () => {
    const h = harness();
    const { userId } = await toPending(h, 250_000); // 实扣 0.5（预留 2）
    const [claim] = await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
    const outcome = await h.settlement.processClaim(defined(claim));
    expect(outcome).toBe('settled');
    expect(defined((await h.wallet.accounts(userId))[0]).balance).toBe('9.5');
    // 认领失效 + usage_logs 已有记录 → already_settled（幂等返回首笔金额）
    const stale = { ...defined(claim), claimToken: 'ghost' };
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
    const outcome = await h.settlement.processClaim(defined(claim));
    expect(outcome).toBe('settled');
    const account = defined((await h.wallet.accounts(userId))[0]);
    expect(account.balance).toBe('10');
    expect(account.inFlight).toBe('0');
    expect(defined(h.world.fixtures.requests.get(requestId)).status).toBe('settled');
  });

  it('毒收据：死信（不重试）——B3 家族经结算管线分型', async () => {
    const h = harness();
    const { requestId } = await toPending(h);
    // 篡改收据价格为垃圾串 → decode 守卫毒收据 → dead
    const row = defined(h.world.fixtures.requests.get(requestId));
    row.receipt = { ...row.receipt, inputPrice: 'garbage' };
    const [claim] = await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
    const outcome = await h.settlement.processClaim(defined(claim));
    expect(outcome).toBe('dead');
    expect(defined(h.world.fixtures.requests.get(requestId)).status).toBe('dead');
  });

  it('经济闭合违反：upstreamCost > 渠道预留 → 死信（B4 红灯不入账，不重试）', async () => {
    const h = harness();
    const { requestId } = await toPending(h);
    // 收据官方成本 = 1M token × 2/M = 2；渠道认领只预留 1.5 → 结算验收门
    // 判内部不一致（价格快照漂移/投影脱节）→ DefectError 死信家族
    const row = defined(h.world.fixtures.requests.get(requestId));
    row.channelReservedAmount = '1.5';
    const [claim] = await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
    const outcome = await h.settlement.processClaim(defined(claim));
    expect(outcome).toBe('dead');
    const after = defined(h.world.fixtures.requests.get(requestId));
    expect(after.status).toBe('dead');
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
    })(defined(claim), new Error('ECONNRESET'));
    expect(retried).toBe('retried');
    const row = defined(h.world.fixtures.requests.get(requestId));
    expect(row.status).toBe('retry_wait');
    // 重领后完整结算
    const [claim2] = await h.settlement.claim({
      ownerId: 'w2',
      batchSize: 10,
      claimLeaseMs: 5_000,
    });
    expect(defined(claim2).requestId).toBe(requestId);
    expect(await h.settlement.processClaim(defined(claim2))).toBe('settled');
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
    expect(defined((await h.wallet.accounts(userIdA))[0]).inFlight).toBe('0');
    expect(defined((await h.wallet.accounts(userIdB))[0]).inFlight).toBe('0');
    expect(defined(h.world.fixtures.requests.get(requestIdA)).status).toBe('released');
  });

  it('processing 认领租约过期 → retry_wait 可重领（再走完整结算）', async () => {
    const h = harness();
    const { requestId } = await toPending(h);
    const [claim] = await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
    // 模拟 worker 崩溃：租约过期 → requeue → retry_wait 可重领
    defined(h.world.fixtures.requests.get(requestId)).claimUntil = new Date(Date.now() - 1);
    const requeued = await h.world.billing.transaction((tx) =>
      h.world.billing.requeueExpiredClaims(tx, 10),
    );
    expect(requeued).toBe(1);
    expect(defined(h.world.fixtures.requests.get(requestId)).status).toBe('retry_wait');
    const [reclaim] = await h.settlement.claim({
      ownerId: 'w2',
      batchSize: 10,
      claimLeaseMs: 5_000,
    });
    expect(defined(reclaim).requestId).toBe(requestId);
    void claim;
  });

  it('abandonOwnedClaims：优雅停机归还本副本认领', async () => {
    const h = harness();
    const { requestId } = await toPending(h);
    await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 60_000 });
    expect(defined(h.world.fixtures.requests.get(requestId)).status).toBe('processing');
    const returned = await h.settlement.abandonOwnedClaims('w1');
    expect(returned).toBe(1);
    expect(defined(h.world.fixtures.requests.get(requestId)).status).toBe('retry_wait');
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
    expect(defined(h.world.fixtures.channelsMap.get(channelId)).upstreamReserved).toBe('2');
    await h.billing.signal({
      type: 'request.succeeded',
      requestId,
      receipt: receiptFor(requestId, userId),
    });
    const [claim] = await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
    const result = await h.settlement.settleClaim(defined(claim));
    expect(result).toMatchObject({ outcome: 'settled', channelCircuitBroken: true });
    // 敞口归还 + 预算扣减（2 − 2 = 0 ≤ 阈值 0.5 → 熔断）
    expect(defined(h.world.fixtures.channelsMap.get(channelId)).upstreamReserved).toBe('0');
    expect(defined(h.world.fixtures.channelsMap.get(channelId)).status).toBe(3);
    void userId;
  });

  it('结算归属校验：收据 userId 与账单错配 → receipt_user_mismatch → dead', async () => {
    const h = harness();
    const { requestId } = await toPending(h);
    const row = defined(h.world.fixtures.requests.get(requestId));
    row.receipt = { ...defined(row.receipt), userId: 424242 };
    const [claim] = await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
    const outcome = await h.settlement.processClaim(defined(claim));
    expect(outcome).toBe('dead');
    expect(defined(h.world.fixtures.requests.get(requestId)).status).toBe('dead');
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
      usageDefectBreaker: 5,
      failurePolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
      clock: () => new Date(),
      onError: () => {},
      onSettled: (data) => {
        observed = { requestId: data.requestId, amount: data.amount };
        throw new Error('hook exploded');
      },
    });
    const { requestId } = await toPending(h);
    const [claim] = await settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
    const outcome = await settlement.processClaim(defined(claim));
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
    defined(h.world.fixtures.requests.get(defined(ids[0]))).reservedAmount = '999';
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
      clock: () => new Date(),
      onError: (error, ctx) => errors.push(ctx),
    })({ batchSize: 10 });
    expect(recoverResult.released).toBe(1); // 毒行被隔离，健康行归还
    expect(errors.length).toBeGreaterThan(0);
    expect(defined(h.world.fixtures.requests.get(defined(ids[1]))).status).toBe('released');
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
      receipt: b ? defined(h.world.fixtures.requests.get(b.requestId)).receipt : null,
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
    expect(defined(h.world.fixtures.channelsMap.get(channelId)).upstreamReserved).toBe('2');
    const released = await h.billing.signal({ type: 'request.failed', requestId, reason: 'x' });
    expect(released).toMatchObject({ changed: true, amountReleased: '2' });
    expect(defined(h.world.fixtures.channelsMap.get(channelId)).upstreamReserved).toBe('0');
  });

  it('failure 的 onDead 钩子：死信时触发一次', async () => {
    const dead: string[] = [];
    const h = harness();
    const { requestId } = await toPending(h);
    const row = defined(h.world.fixtures.requests.get(requestId));
    row.receipt = { ...defined(row.receipt), inputPrice: 'garbage' };
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
      usageDefectBreaker: 5,
      failurePolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
      clock: () => new Date(),
      onError: () => {},
      onDead: (data) => dead.push(data.requestId),
    });
    // 该认领已被上一 settlement 持有——直接用失败处置走 dead 分支
    const outcome = await (
      await import('../src/application/settlement/failure.js')
    ).createFailureUseCase({
      store: h.world.billing,
      policy: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 1_000 },
      onDead: (data) => dead.push(data.requestId),
    })(defined(claim), new Error('boom'));
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
    const token = defined(defined(h.world.fixtures.requests.get(requestId)).claimToken);
    await h.settlement.renewClaims({ ownerId: 'w9', tokens: [token], claimLeaseMs: 60_000 });
    expect(
      defined(defined(h.world.fixtures.requests.get(requestId)).claimUntil).getTime(),
    ).toBeGreaterThan(Date.now() - 1000);
  });
});

describe('结算不变量红灯（分支封口）', () => {
  it('明细加总 ≠ 账单总预扣 → 投影脱节红灯（DefectError → dead）', async () => {
    const h = harness();
    const { requestId } = await toPending(h);
    defined(h.world.fixtures.requests.get(requestId)).reservedAmount = '999';
    const [claim] = await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
    const outcome = await h.settlement.processClaim(defined(claim));
    expect(outcome).toBe('dead');
  });

  it('认领 CAS 输家（revision 被并发推进）→ 不变量红灯', async () => {
    const h = harness();
    const { requestId } = await toPending(h);
    const [claim] = await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
    defined(h.world.fixtures.requests.get(requestId)).revision += 100; // 模拟并发对手推进
    const outcome = await h.settlement.processClaim(defined(claim));
    // 五元组失配 → findProcessingForClaim null 且无 usage → claim_lost（幂等安全）
    expect(outcome).toBe('claim_lost');
  });
});

describe('结算 usage 投影冲突红灯', () => {
  it('usage_logs 已有行（requestId 唯一冲突）→ settle_usage_conflict → dead', async () => {
    const h = harness();
    const { requestId } = await toPending(h);
    // 预插投影行：insertUsageLog 幂等落空 → 红灯（数据脱节防御）
    h.world.fixtures.usageLogs.set(requestId, { requestId, calculatedAmount: '2' });
    const [claim] = await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
    const outcome = await h.settlement.processClaim(defined(claim));
    expect(outcome).toBe('dead');
    expect(defined(h.world.fixtures.requests.get(requestId)).status).toBe('dead');
  });
});

describe('超收钳制（#over 死信回归：巨量 usage 不再阻死结算）', () => {
  it('actual 超预留且超可用：钳到可收额，差额 waived 落库，余额不为负', async () => {
    const h = harness();
    // fixed 预留 0.01 + 界内大发票（upper 100M，收据 100M × 2/1M = 200）→ 可用 10 全收
    const { userId, requestId } = await toPending(h, 100_000_000, {
      inputUpper: 100_000_000,
      reservationPolicy: { mode: 'fixed', amount: '0.01' },
      reservationLimit: '1000',
    });
    const [claim] = await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
    const outcome = await h.settlement.processClaim(defined(claim));
    expect(outcome).toBe('settled');
    const account = defined((await h.wallet.accounts(userId))[0]);
    expect(account.balance).toBe('0'); // 10 − (2 预留内 + 8 可收) —— 恒不为负
    expect(account.inFlight).toBe('0');
    const row = defined(h.world.fixtures.requests.get(requestId));
    expect(row.status).toBe('settled');
    expect(row.waivedAmount).toBe('190');
    const usage = defined(h.world.fixtures.usageLogs.get(requestId));
    expect(usage.calculatedAmount).toBe('10'); // 投影按实收（应收 − 放弃）
  });

  it('可用恰好覆盖超额：全额收取 waived=0', async () => {
    const h = harness();
    const { userId, requestId } = await toPending(h, 5_000_000, {
      inputUpper: 100_000_000,
      reservationPolicy: { mode: 'fixed', amount: '0.01' },
      reservationLimit: '1000',
    }); // 应收 10（5M × 2/1M）= 恰好可用
    const [claim] = await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
    expect(await h.settlement.processClaim(defined(claim))).toBe('settled');
    expect(defined((await h.wallet.accounts(userId))[0]).balance).toBe('0');
    expect(defined(h.world.fixtures.requests.get(requestId)).waivedAmount).toBe('0');
  });
});

describe('批量结算（账户行锁摊薄）', () => {
  it('settleClaims：两单一事务全部落定（余额/在途/usage 各自正确）', async () => {
    const h = harness();
    const a = await toPending(h);
    const b = await toPending(h);
    const claims = await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
    expect(claims).toHaveLength(2);
    const results = await h.settlement.settleClaims(claims);
    expect(results.map((r) => r.outcome)).toEqual(['settled', 'settled']);
    expect(defined((await h.wallet.accounts(a.userId))[0]).balance).toBe('8');
    expect(defined((await h.wallet.accounts(b.userId))[0]).balance).toBe('8');
    expect(defined(h.world.fixtures.requests.get(a.requestId)).status).toBe('settled');
    expect(defined(h.world.fixtures.requests.get(b.requestId)).status).toBe('settled');
  });

  it('批内毒账单：整批回滚上抛（调用方回退逐张隔离）', async () => {
    const h = harness();
    const good = await toPending(h);
    const bad = await toPending(h);
    const row = defined(h.world.fixtures.requests.get(bad.requestId));
    row.receipt = { ...row.receipt, inputPrice: 'garbage' };
    const claims = await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
    await expect(h.settlement.settleClaims(claims)).rejects.toThrow();
    // 回退逐张：好单结算、毒单死信
    expect(await h.settlement.processClaim(defined(claims[0]))).toMatch(/settled|dead/);
    expect(await h.settlement.processClaim(defined(claims[1]))).toMatch(/settled|dead/);
    expect(defined(h.world.fixtures.requests.get(good.requestId)).status).toBe('settled');
    expect(defined(h.world.fixtures.requests.get(bad.requestId)).status).toBe('dead');
  });

  it('空批安全返回', async () => {
    const h = harness();
    expect(await h.settlement.settleClaims([])).toEqual([]);
  });
});

describe('用量验收门（症状回归：上游伪造巨量发票曾打穿渠道预算至 -3999 万）', () => {
  /** 伪造发票场景装置：quote 界内物理上限小，发票 3000 万 token（物理不可能） */
  async function forgedInvoiceCase(h: ReturnType<typeof harness>, channelId: number) {
    const userId = nextUser();
    await h.wallet.credit({ userId, amount: '20010', refType: 'topup', refId: `fg-${userId}` });
    const requestId = nextRequestId();
    await h.billing.authorize({
      requestId,
      userId,
      stream: false,
      quote: {
        maxOutputTokens: 100,
        candidates: [
          {
            mappingId: 1,
            externalModel: 'm',
            realModel: 'm',
            inputPrice: '2000',
            outputPrice: '0',
            cacheInputPrice: '0',
            coefficient: '1',
            inputTokenUpperBound: 1_000,
            billingPolicyFingerprint: null,
          },
        ],
      },
      reservationLimit: '1000',
      authorizationTtlMs: 60_000,
    });
    await h.billing.reserveChannel({ requestId, channelId, amount: '2' });
    await h.billing.signal({
      type: 'request.succeeded',
      requestId,
      receipt: receiptFor(requestId, userId, {
        channelId,
        inputPrice: '2000',
        outputPrice: '0',
        usage: {
          inputTokens: 20_000_000,
          cachedInputTokens: 0,
          outputTokens: 0,
          estimated: false,
        },
      }),
    });
    return { userId, requestId };
  }

  it('伪造 3000 万 token 发票：钳到准入界结算，渠道预算不穿底，缺陷 +1 不熔断', async () => {
    const h = harness();
    const channelId = seedChannel(h.world, { upstreamBudget: '1000' });
    const { userId, requestId } = await forgedInvoiceCase(h, channelId);
    const [claim] = await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
    expect(await h.settlement.processClaim(defined(claim))).toBe('settled');

    const channel = defined(h.world.fixtures.channelsMap.get(channelId));
    // 旧实现此处预算 = 1000 − 40000 = −39000（穿底）；新实现按验收值 2 扣减
    expect(channel.upstreamBudget).toBe('998');
    expect(channel.usageEvidenceDefects).toBe(1);
    expect(channel.status).toBe(0); // 未过阈不熔断
    // 用户按验收值计费（1000 × 2000/1M = 2）
    const usage = defined(h.world.fixtures.usageLogs.get(requestId));
    expect(usage.calculatedAmount).toBe('2');
    const account = defined((await h.wallet.accounts(userId))[0]);
    expect(account.balance).toBe('20008');
  });

  it('累计缺陷过阈 → 渠道熔断（status=3）', async () => {
    const h = harness();
    const channelId = seedChannel(h.world, { upstreamBudget: '1000' });
    for (let i = 0; i < 5; i++) {
      await forgedInvoiceCase(h, channelId);
    }
    const claims = await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
    for (const claim of claims) {
      expect(await h.settlement.processClaim(defined(claim))).toBe('settled');
    }
    const channel = defined(h.world.fixtures.channelsMap.get(channelId));
    expect(channel.usageEvidenceDefects).toBe(5);
    expect(channel.status).toBe(3);
  });

  it('B4 经济闭合（界内发票但渠道预留低于应收官方成本）→ DefectError 死信', async () => {
    const h = harness();
    const channelId = seedChannel(h.world, { upstreamBudget: '10' });
    const userId = nextUser();
    await h.wallet.credit({ userId, amount: '10', refType: 'topup', refId: `b4-${userId}` });
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
    // 人为制造不一致：渠道预留 0.5 < 界内应收 2（正常授权链路不可能——预留=最坏Case）
    await h.billing.reserveChannel({ requestId, channelId, amount: '0.5' });
    await h.billing.signal({
      type: 'request.succeeded',
      requestId,
      receipt: receiptFor(requestId, userId, {
        channelId,
        usage: { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0, estimated: false },
      }),
    });
    const [claim] = await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
    expect(await h.settlement.processClaim(defined(claim))).toBe('dead');
    expect(defined(h.world.fixtures.requests.get(requestId)).status).toBe('dead');
  });
});
