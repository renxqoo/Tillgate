/**
 * 收据校准结算路径契约测试（docs/calibrated-exposure-estimate.md §4.2/§3.1）：
 * B4 三分支（NULL 死信 / 容错区间超额扣减 / 超保守死信）+ 结算事务末尾校准
 * 写入（C7a/C7b 守卫）+ 回归锚（非校准请求行为与现状一致）。
 * 内存 stand-in；结算夹具直驱 store（authorize 全链在 billing-authorize.test）。
 */
import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/domain/money.js';
import { createSettlementApi } from '../src/application/settlement/settlement.js';
import { createDefaultFundingRegistry } from '../src/application/billing/billing.js';
import { createWalletApi } from '../src/application/wallet/wallet.js';
import { createInMemoryWalletStore } from '../src/testing/in-memory-wallet-store.js';
import { createInMemoryBillingWorld, seedChannel } from '../src/testing/in-memory-billing-store.js';
import type { UsageReceipt } from '../src/domain/rating/types.js';
import { defined } from './defined.js';

let userSeq = 5900;
let reqSeq = 0;
const nextUser = () => (userSeq += 1);
const nextRequestId = () => {
  const n = (reqSeq += 1);
  const hex = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}${'0'.repeat(12 - hex.length)}`.slice(0, 36);
};

interface Harness {
  world: ReturnType<typeof createInMemoryBillingWorld>;
  walletApi: ReturnType<typeof createWalletApi>;
  channelId: number;
  settlement: ReturnType<typeof createSettlementApi>;
  dead: string[];
}

function harness(): Harness {
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
  const channelId = seedChannel(world, { upstreamBudget: '100' });
  const dead: string[] = [];
  const settlement = createSettlementApi({
    store: world.billing,
    walletStore: walletMemory.store,
    fundingRegistry,
    channels: world.channels,
    calibrations: world.calibrations,
    usageDefectBreaker: 5,
    failurePolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    clock: () => new Date(),
    onError: () => {},
    onDead: (data) => {
      dead.push(`${data.requestId}:${data.lastError.slice(0, 200)}`);
    },
  });
  return { world, walletApi: wallet, channelId, settlement, dead };
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

/**
 * 直插 store 夹具推进到 settlement_pending + 渠道认领事实（校准/保守双金额）。
 * 本文件聚焦结算对 channelReservedAmount/conservativeChannelAmount 的消费分支。
 */
async function toPendingClaimed(
  h: Harness,
  input: {
    requestId: string;
    userId: number;
    reserved: string;
    conservative?: string | null;
    receiptTokens?: number;
    quoteCalibration?: Record<string, unknown> | null;
  },
): Promise<void> {
  const { world, channelId } = h;
  const now = new Date();
  await h.walletApi.credit({
    userId: input.userId,
    amount: '100',
    refType: 'topup',
    refId: `c-${input.requestId}`,
  });
  // PAYG 预占（payg-source settle 的授权行——与 authorize 全链的 wallet 腿等价）
  await h.walletApi.authorize({
    userId: input.userId,
    amount: input.reserved,
    currency: 'CNY',
    refType: 'billing',
    refId: input.requestId,
    memo: `calib test ${input.requestId}`,
  });
  await world.billing.insertAuthorized(undefined as never, {
    requestId: input.requestId,
    userId: input.userId,
    apiKeyId: null,
    estimatedExposureAmount: input.reserved,
    reservedAmount: input.reserved,
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
      ...(input.quoteCalibration != null ? { calibration: input.quoteCalibration } : {}),
    },
    authorizationFingerprint: `fp-${input.requestId}`,
    traceParent: null,
    leaseExpiresAt: new Date(now.getTime() + 60_000),
    nextSettlementAt: now,
    createdAt: now,
  });
  await world.billing.casClaimChannel(undefined as never, {
    requestId: input.requestId,
    fromStatus: ['authorized', 'in_flight'],
    expectedChannelId: null,
    expectedReserved: null,
    channelId,
    channelReservedAmount: input.reserved,
    ...(input.conservative !== undefined ? { conservativeChannelAmount: input.conservative } : {}),
    now,
  });
  // reserveChannel 的 channels 敞口腿（结算 tryDecreaseReserved 的对称面）
  const ch = defined(world.fixtures.channelsMap.get(channelId));
  ch.upstreamReserved = String(Number(ch.upstreamReserved) + Number(input.reserved));
  await world.billing.casTransition(undefined as never, {
    requestId: input.requestId,
    from: ['authorized'],
    to: 'settlement_pending',
    set: {
      receipt: receiptOf({
        requestId: input.requestId,
        userId: input.userId,
        channelId,
        inputTokens: input.receiptTokens ?? 2_000_000,
      }) as unknown as Record<string, unknown>,
    },
  });
  await world.billing.transaction(async (tx) => {
    await world.billing.insertReservation(tx, {
      billingRequestId: input.requestId,
      sourceType: 'payg',
      sourceRefId: null,
      amount: input.reserved,
    });
  });
}

async function settle(h: Harness, requestId: string): Promise<string> {
  const [claim] = await h.settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 5_000 });
  expect(defined(claim).requestId).toBe(requestId);
  return await h.settlement.processClaim(defined(claim));
}

describe('路 B#2：estimated_exposure_amount 落库保守口径（订阅限额 exposure 面）', () => {
  it('校准命中 authorize → exposure 列 = 字节界保守值（非校准收缩值）', async () => {
    const h = harness();
    const userId = nextUser();
    const requestId = nextRequestId();
    await h.walletApi.credit({ userId, amount: '100', refType: 'topup', refId: `c-${requestId}` });
    await h.walletApi.authorize({
      userId,
      amount: '2', // 保守口径冻结（user_side 计算链外——直驱）
      currency: 'CNY',
      refType: 'billing',
      refId: requestId,
      memo: `b2 ${requestId}`,
    });
    await h.world.billing.insertAuthorized(undefined as never, {
      requestId,
      userId,
      apiKeyId: null,
      estimatedExposureAmount: '2', // 保守（1M×2/M）；校准收缩值会是 0.09
      reservedAmount: '2',
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
            inputTokenUpperBound: 1_000_000,
            calibratedInputTokenUpperBound: 45_000,
            billingPolicyFingerprint: null,
          },
        ],
        calibration: {
          mappingId: 13,
          prefixHash: 'b2',
          channelId: h.channelId,
          inputTokens: 45_000,
          messagesLen: 2,
          prefixBytes: 180_000,
          cacheRatio: 0.9,
        },
      },
      authorizationFingerprint: `fp-${requestId}`,
      traceParent: null,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      nextSettlementAt: new Date(),
      createdAt: new Date(),
    });
    const row = h.world.fixtures.requests.get(requestId);
    expect(row).toBeDefined();
    expect((row as { estimatedExposureAmount: string }).estimatedExposureAmount).toBe('2');
  });
});

describe('B4 三分支（docs §4.2）', () => {
  // 收据 2M token × 2 元/M = 4 元 upstreamCost（全价输入）
  it('分支①：conservative 为 NULL（保守预留）+ 超界 → 死信（原语义不动）', async () => {
    const h = harness();
    await toPendingClaimed(h, {
      requestId: nextRequestId(),
      userId: nextUser(),
      reserved: '1', // 预留 1 < 实际 4 → B4 超界
      conservative: null, // 保守预留（无校准）
    });
    const requestId = defined([...h.world.fixtures.requests.keys()].at(-1));
    expect(await settle(h, requestId)).toBe('dead');
    expect(h.dead[0]).toContain('upstreamCost');
  });

  it('分支②：容错区间（校准预留 < 实际 ≤ 保守金额）→ 超额扣减不死信，渠道按实际成本扣', async () => {
    const h = harness();
    const userId = nextUser();
    const requestId = nextRequestId();
    await toPendingClaimed(h, {
      requestId,
      userId,
      reserved: '1', // 校准预估预留 1
      conservative: '5', // reserve 时保守口径 5 ≥ 实际 4
    });
    expect(await settle(h, requestId)).toBe('settled');
    const row = defined(h.world.fixtures.requests.get(requestId));
    expect(row.status).toBe('settled'); // 不死信
    const channel = defined(h.world.fixtures.channelsMap.get(h.channelId));
    // 渠道预算按实际成本 4 扣（超额扣减）；敞口按预留 1 归还
    expect(new Decimal(channel.upstreamBudget).toString()).toBe('96');
    expect(new Decimal(channel.upstreamReserved).toString()).toBe('0');
  });

  it('分支③：实际超保守金额（价格漂移口径）→ 死信（探测器保留）', async () => {
    const h = harness();
    await toPendingClaimed(h, {
      requestId: nextRequestId(),
      userId: nextUser(),
      reserved: '1',
      conservative: '3', // 保守口径 3 < 实际 4 → 探测器
    });
    const requestId = defined([...h.world.fixtures.requests.keys()].at(-1));
    expect(await settle(h, requestId)).toBe('dead');
    expect(h.dead[0]).toContain('upstreamCost');
  });

  it('回归锚：非校准请求（预留 ≥ 实际）行为不变 → settled', async () => {
    const h = harness();
    const userId = nextUser();
    const requestId = nextRequestId();
    await toPendingClaimed(h, {
      requestId,
      userId,
      reserved: '5', // 保守预留 5 ≥ 实际 4
    });
    expect(await settle(h, requestId)).toBe('settled');
    const channel = defined(h.world.fixtures.channelsMap.get(h.channelId));
    expect(new Decimal(channel.upstreamBudget).toString()).toBe('96');
    expect(new Decimal(channel.upstreamReserved).toString()).toBe('0');
  });
});

describe('结算事务末尾校准写入（docs §3.1/§4.2）', () => {
  const calibration = {
    mappingId: 13,
    prefixHash: 'abc',
    channelId: 0, // toPendingClaimed 内被实际渠道覆盖断言用占位
    inputTokens: 1_000_000,
    messagesLen: 2,
    prefixBytes: 3_000_000, // bytes/4 = 750k ≤ 2M ✓
  };

  it('quote.calibration + 零钳制 trusted 收据 → 写记录（收据实测值）', async () => {
    const h = harness();
    const userId = nextUser();
    const requestId = nextRequestId();
    await toPendingClaimed(h, {
      requestId,
      userId,
      reserved: '4',
      quoteCalibration: calibration,
    });
    expect(await settle(h, requestId)).toBe('settled');
    const record = h.world.fixtures.calibrations.get(`${userId}\0${13}\0${'abc'}`);
    expect(record).toBeDefined();
    expect(defined(record).inputTokens).toBe(2_000_000); // 写收据值非快照值
    expect(defined(record).channelId).toBe(h.channelId); // 收据渠道（实际服务渠道）
  });

  it('C7a：钳制收据（发票超字节界）→ 不写记录', async () => {
    const h = harness();
    await toPendingClaimed(h, {
      requestId: nextRequestId(),
      userId: nextUser(),
      reserved: '4',
      receiptTokens: 20_000_000, // 超 quote 上界 10M → 钳制
      quoteCalibration: calibration,
    });
    await settle(h, defined([...h.world.fixtures.requests.keys()].at(-1)));
    expect(h.world.fixtures.calibrations.size).toBe(0); // 钳制 → 拒写
  });

  it('C7b：低报计数器（inputTokens < prefixBytes/4）→ 不写记录', async () => {
    const h = harness();
    await toPendingClaimed(h, {
      requestId: nextRequestId(),
      userId: nextUser(),
      reserved: '4',
      receiptTokens: 100_000, // bytes/4 = 750k > 100k → 低报
      quoteCalibration: calibration,
    });
    await settle(h, defined([...h.world.fixtures.requests.keys()].at(-1)));
    expect(h.world.fixtures.calibrations.size).toBe(0);
  });

  it('估算收据（estimated）→ 不写记录', async () => {
    const h = harness();
    const requestId = nextRequestId();
    await toPendingClaimed(h, {
      requestId,
      userId: nextUser(),
      reserved: '4',
      quoteCalibration: calibration,
    });
    const row = defined(h.world.fixtures.requests.get(requestId));
    (row.receipt as { usage: { estimated: boolean } }).usage.estimated = true;
    await settle(h, requestId);
    expect(h.world.fixtures.calibrations.size).toBe(0);
  });

  it('无 quote.calibration（非校准请求）→ 不写记录', async () => {
    const h = harness();
    await toPendingClaimed(h, {
      requestId: nextRequestId(),
      userId: nextUser(),
      reserved: '4',
    });
    await settle(h, defined([...h.world.fixtures.requests.keys()].at(-1)));
    expect(h.world.fixtures.calibrations.size).toBe(0);
  });
});

describe('校准 store 契约（in-memory = postgres 同款语义）', () => {
  it('findRecent：settled_at 倒序 top-N', async () => {
    const h = harness();
    for (let i = 0; i < 12; i += 1) {
      await h.world.calibrations.upsert(undefined as never, {
        userId: 7001,
        mappingId: 13,
        prefixHash: `h${i}`,
        channelId: h.channelId,
        inputTokens: 1000,
        messagesLen: i + 1,
        requestId: `r${i}`,
        now: new Date(Date.UTC(2026, 9, 1, 0, i)),
      });
    }
    const top = await h.world.calibrations.findRecent(undefined as never, {
      userId: 7001,
      mappingId: 13,
      limit: 8,
    });
    expect(top).toHaveLength(8);
    expect(defined(top[0]).prefixHash).toBe('h11'); // 最新在前
    expect(defined(top[7]).prefixHash).toBe('h4');
  });

  it('upsert 主键冲突覆盖不累积；cleanup 保留 top-keep 驱逐更旧', async () => {
    const h = harness();
    await h.world.calibrations.upsert(undefined as never, {
      userId: 7002,
      mappingId: 13,
      prefixHash: 'dup',
      channelId: h.channelId,
      inputTokens: 111,
      messagesLen: 2,
      requestId: 'r-old',
      now: new Date(Date.UTC(2026, 9, 1)),
    });
    await h.world.calibrations.upsert(undefined as never, {
      userId: 7002,
      mappingId: 13,
      prefixHash: 'dup',
      channelId: h.channelId,
      inputTokens: 222,
      messagesLen: 3,
      requestId: 'r-new',
      now: new Date(Date.UTC(2026, 9, 2)),
    });
    let rows = [...h.world.fixtures.calibrations.values()].filter((r) => r.prefixHash === 'dup');
    expect(rows).toHaveLength(1);
    expect(defined(rows[0]).inputTokens).toBe(222); // 后写覆盖

    for (let i = 0; i < 10; i += 1) {
      await h.world.calibrations.upsert(undefined as never, {
        userId: 7003,
        mappingId: 13,
        prefixHash: `h${i}`,
        channelId: h.channelId,
        inputTokens: 1000,
        messagesLen: i + 1,
        requestId: `r${i}`,
        now: new Date(Date.UTC(2026, 9, 1, 0, i)),
      });
    }
    const evicted = await h.world.calibrations.cleanup(undefined as never, {
      userId: 7003,
      mappingId: 13,
      keep: 8,
    });
    expect(evicted).toBe(2);
    rows = [...h.world.fixtures.calibrations.values()].filter((r) => r.userId === 7003);
    expect(rows.map((r) => r.prefixHash).toSorted()).toEqual([
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'h7',
      'h8',
      'h9',
    ]);
  });
});
