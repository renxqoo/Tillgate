/**
 * 计费授权链契约测试（内存 stand-in；真实 PG 的 CAS/advisory 语义由真实套件覆盖）。
 * 覆盖：授权瀑布（PAYG/订阅切分/免费快路径/重放/不足/日限）、signal 四事件、
 * reserveChannel 三模式、积压准入。
 */
import { describe, expect, it } from 'vitest';
import { isBusinessError } from '@tillgate/errors';
import { createWalletApi } from '../src/application/wallet/wallet.js';
import { createBillingApi, createBillingAdmission } from '../src/application/billing/billing.js';
import { createInMemoryWalletStore } from '../src/testing/in-memory-wallet-store.js';
import {
  createInMemoryBillingWorld,
  seedChannel,
  seedSubscription,
} from '../src/testing/in-memory-billing-store.js';
import type { BillingQuote } from '../src/domain/rating/types.js';
import { defined } from './defined.js';

let userSeq = 100;
let reqSeq = 0;
const nextUser = () => (userSeq += 1);
const nextRequestId = () => {
  const n = (reqSeq += 1);
  const hex = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}${'0'.repeat(12 - hex.length)}`.slice(0, 36);
};

function quote(input: string, output: string): BillingQuote {
  return {
    maxOutputTokens: 0,
    candidates: [
      {
        mappingId: 1,
        externalModel: 'm',
        realModel: 'm',
        inputPrice: input,
        outputPrice: output,
        cacheInputPrice: '0',
        coefficient: '1',
        inputTokenUpperBound: 1_000_000,
        billingPolicyFingerprint: null,
      },
    ],
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
  const api = createBillingApi({
    store: world.billing,
    resolver: world.resolver,
    quota: world.quota,
    channels: world.channels,
    walletStore: walletMemory.store,
    wallet,
    currency: 'CNY',
    clock: () => new Date(),
  });
  return { wallet, walletMemory, world, api };
}

async function rejection(
  fn: () => Promise<unknown>,
): Promise<{ code: string; context: Record<string, unknown> }> {
  try {
    await fn();
  } catch (error) {
    if (isBusinessError(error)) {
      return { code: error.code, context: (error.context ?? {}) as Record<string, unknown> };
    }
    throw error;
  }
  throw new Error('expected rejection');
}

const TTL = 60_000;

describe('authorize（资金瀑布）', () => {
  it('纯 PAYG：预估冻结钱包（inFlight 占用）、投影三列落账、重放幂等', async () => {
    const { wallet, world, api } = harness();
    const userId = nextUser();
    await wallet.credit({ userId, amount: '10', refType: 'topup', refId: 'c1' });
    const requestId = nextRequestId();
    // (1M×2)/1M = 2
    const first = await api.authorize({
      requestId,
      userId,
      stream: false,
      quote: quote('2', '0'),
      reservationLimit: '10',
      authorizationTtlMs: TTL,
    });
    expect(first).toMatchObject({ reservedAmount: '2', replayed: false });
    expect(first.availableBalance).toBe('8');
    const account = defined((await wallet.accounts(userId))[0]);
    expect(account.inFlight).toBe('2');
    const row = await world.billing.read((conn) => world.billing.findByRequestId(conn, requestId));
    expect(row).toMatchObject({
      reservedAmount: '2',
      estimatedExposureAmount: '2',
      planReservedAmount: null,
      subscriptionId: null,
      status: 'authorized',
    });
    // 重放：同参数不重复冻结
    const replay = await api.authorize({
      requestId,
      userId,
      stream: false,
      quote: quote('2', '0'),
      reservationLimit: '10',
      authorizationTtlMs: TTL,
    });
    expect(replay.replayed).toBe(true);
    expect(defined((await wallet.accounts(userId))[0]).inFlight).toBe('2');
  });

  it('全链不足 fail-closed（insufficient_balance），零残留', async () => {
    const { wallet, api } = harness();
    const userId = nextUser();
    await wallet.credit({ userId, amount: '1', refType: 'topup', refId: 'c2' });
    const rejected = await rejection(() =>
      api.authorize({
        requestId: nextRequestId(),
        userId,
        stream: false,
        quote: quote('2', '0'),
        reservationLimit: '10',
        authorizationTtlMs: TTL,
      }),
    );
    expect(rejected.code).toBe('billing.insufficient_balance');
    expect(defined((await wallet.accounts(userId))[0]).inFlight).toBe('0');
  });

  it('免费快路径：explicitlyFree 全零价 → 0 元空计划（不冻结，账单行仅供观测）', async () => {
    const { world, api } = harness();
    const userId = nextUser();
    const requestId = nextRequestId();
    const result = await api.authorize({
      requestId,
      userId,
      stream: false,
      quote: { ...quote('0', '0'), explicitlyFree: true },
      reservationLimit: '10',
      authorizationTtlMs: TTL,
    });
    expect(result.reservedAmount).toBe('0');
    const row = await world.billing.read((conn) => world.billing.findByRequestId(conn, requestId));
    expect(defined(row).reservedAmount).toBe('0');
  });

  it('订阅 + PAYG 切分：订阅先耗、余额补差；投影记录订阅份额', async () => {
    const { wallet, world, api } = harness();
    const userId = nextUser();
    await wallet.credit({ userId, amount: '1', refType: 'topup', refId: 'c3' });
    const subscriptionId = seedSubscription(world, { userId, quotaAmount: '1' });
    world.resolveOverride = { subscriptionId, allowPaygFallback: true };
    const result = await api.authorize({
      requestId: nextRequestId(),
      userId,
      stream: false,
      quote: quote('2', '0'),
      reservationLimit: '10',
      authorizationTtlMs: TTL,
    });
    expect(result.reservedAmount).toBe('2');
    const sub = defined(world.fixtures.subscriptions.get(subscriptionId));
    expect(sub.reservedAmount).toBe('1'); // 订阅先耗 1
    expect(defined((await wallet.accounts(userId))[0]).inFlight).toBe('1'); // PAYG 补差 1
  });

  it('订阅开关 OFF 且额度不足 → 整单拒绝（subscription_quota_exhausted），零残留', async () => {
    const { wallet, world, api } = harness();
    const userId = nextUser();
    await wallet.credit({ userId, amount: '5', refType: 'topup', refId: 'c4' });
    const subscriptionId = seedSubscription(world, { userId, quotaAmount: '1' });
    world.resolveOverride = { subscriptionId, allowPaygFallback: false };
    const rejected = await rejection(() =>
      api.authorize({
        requestId: nextRequestId(),
        userId,
        stream: false,
        quote: quote('2', '0'),
        reservationLimit: '10',
        authorizationTtlMs: TTL,
      }),
    );
    expect(rejected.code).toBe('billing.subscription_quota_exhausted');
    expect(defined((await wallet.accounts(userId))[0]).inFlight).toBe('0');
    expect(defined(world.fixtures.subscriptions.get(subscriptionId)).reservedAmount).toBe('0');
  });

  it('每日限额：projected = 已结算 + 在途 + 本次 > 限额 → daily_spend_limit', async () => {
    const { wallet, world, api } = harness();
    const userId = nextUser();
    await wallet.credit({ userId, amount: '100', refType: 'topup', refId: 'c5' });
    world.resolveOverride = { userDailyLimit: '10' };
    // 在途 8（先授权一笔）+ 本次 2.01 → 超限
    await api.authorize({
      requestId: nextRequestId(),
      userId,
      stream: false,
      quote: quote('8', '0'),
      reservationLimit: '100',
      authorizationTtlMs: TTL,
    });
    const rejected = await rejection(() =>
      api.authorize({
        requestId: nextRequestId(),
        userId,
        stream: false,
        quote: quote('2.01', '0'),
        reservationLimit: '100',
        authorizationTtlMs: TTL,
      }),
    );
    expect(rejected.code).toBe('billing.daily_spend_limit');
    expect(rejected.context.scope).toBe('user');
  });

  it('单请求上限：预估超 reservationLimit → reservation_limit_exceeded（只拒绝不截断）', async () => {
    const { wallet, api } = harness();
    const userId = nextUser();
    await wallet.credit({ userId, amount: '100', refType: 'topup', refId: 'c6' });
    const rejected = await rejection(() =>
      api.authorize({
        requestId: nextRequestId(),
        userId,
        stream: false,
        quote: quote('2', '0'),
        reservationLimit: '1',
        authorizationTtlMs: TTL,
      }),
    );
    expect(rejected.code).toBe('billing.reservation_limit_exceeded');
  });
});

describe('signal（四事件）', () => {
  async function authorized() {
    const h = harness();
    const userId = nextUser();
    await h.wallet.credit({ userId, amount: '10', refType: 'topup', refId: `s-${userId}` });
    const requestId = nextRequestId();
    await h.api.authorize({
      requestId,
      userId,
      stream: true,
      quote: quote('2', '0'),
      reservationLimit: '10',
      authorizationTtlMs: TTL,
    });
    return { ...h, userId, requestId };
  }

  it('upstream.started → in_flight 起租约；重复事件自然幂等（旧语义：authorized|in_flight 恒命中）', async () => {
    const { api, requestId } = await authorized();
    const first = await api.signal({
      type: 'upstream.started',
      requestId,
      leaseOwner: 'w1',
      leaseMs: 1000,
    });
    expect(first).toMatchObject({ changed: true, status: 'in_flight' });
    const again = await api.signal({
      type: 'upstream.started',
      requestId,
      leaseOwner: 'w1',
      leaseMs: 1000,
    });
    expect(again).toMatchObject({ changed: true, status: 'in_flight' });
  });

  it('request.succeeded：验收落收据转 settlement_pending；毒收据拒绝；同收据重放幂等', async () => {
    const { api, requestId, userId } = await authorized();
    const receipt = {
      requestId,
      userId,
      apiKeyId: null,
      appId: null,
      credentialType: 'key',
      externalModel: 'm',
      realModel: 'm',
      channelId: null,
      channelKey: 't',
      usage: { inputTokens: 500_000, cachedInputTokens: 0, outputTokens: 0, estimated: false },
      inputPrice: '2',
      outputPrice: '0',
      cacheInputPrice: '0',
      coefficient: '1',
      durationMs: 10,
      stream: true,
      streamAborted: false,
      mappingId: 1,
      billingPolicyFingerprint: null,
    };
    const ok = await api.signal({ type: 'request.succeeded', requestId, receipt });
    expect(ok).toMatchObject({ changed: true, status: 'settlement_pending' });
    const replay = await api.signal({ type: 'request.succeeded', requestId, receipt });
    expect(replay).toMatchObject({ changed: false, replayed: true, status: 'settlement_pending' });
    // 已 pending 后的错用户收据：指纹不匹配 + 状态不符 → state_conflict（旧语义：
    // user_mismatch 只在首次交付的 validateReceipt 出现）
    const late = await rejection(() =>
      api.signal({
        type: 'request.succeeded',
        requestId,
        receipt: { ...receipt, userId: userId + 1 },
      }),
    );
    expect(late.code).toBe('billing.state_conflict');
  });

  it('lease.renewed：in_flight 续租成功；非 in_flight 状态幂等返回现状', async () => {
    const { api, requestId } = await authorized();
    // 尚未 upstream.started（status=authorized）→ 续租 CAS 落空 → replayed 现状
    const before = await api.signal({
      type: 'lease.renewed',
      requestId,
      leaseOwner: 'w1',
      leaseMs: 1000,
    });
    expect(before).toMatchObject({ changed: false, replayed: true, status: 'authorized' });
    await api.signal({ type: 'upstream.started', requestId, leaseOwner: 'w1', leaseMs: 1000 });
    const renewed = await api.signal({
      type: 'lease.renewed',
      requestId,
      leaseOwner: 'w1',
      leaseMs: 5000,
    });
    expect(renewed).toMatchObject({ changed: true, status: 'in_flight' });
  });

  it('lease.renewed owner 校验：他人 owner 续租失败（租约归属/到期不被改写）', async () => {
    const { api, world, requestId } = await authorized();
    await api.signal({ type: 'upstream.started', requestId, leaseOwner: 'w1', leaseMs: 1000 });
    const row = defined(world.fixtures.requests.get(requestId));
    const heldUntil = defined(row.leaseExpiresAt).getTime();
    // 并发网关副本（非当前持有者）续租：CAS 落空 → changed=false，现状幂等返回
    const stranger = await api.signal({
      type: 'lease.renewed',
      requestId,
      leaseOwner: 'stranger',
      leaseMs: 60_000,
    });
    expect(stranger).toMatchObject({ changed: false, replayed: true, status: 'in_flight' });
    // 租约事实未被改写：owner 仍是 w1，到期未被推移（不被陌生续租「抢占续命」）
    expect(row.leaseOwner).toBe('w1');
    expect(defined(row.leaseExpiresAt).getTime()).toBe(heldUntil);
    // 持有者本人续租仍成功（守卫不误伤正常保活）
    const own = await api.signal({
      type: 'lease.renewed',
      requestId,
      leaseOwner: 'w1',
      leaseMs: 60_000,
    });
    expect(own).toMatchObject({ changed: true, status: 'in_flight' });
    expect(defined(row.leaseExpiresAt).getTime()).toBeGreaterThan(heldUntil);
  });

  it('request.failed 重放：已 released → 幂等返回现状', async () => {
    const { api, requestId } = await authorized();
    await api.signal({ type: 'request.failed', requestId, reason: 'x' });
    const replay = await api.signal({ type: 'request.failed', requestId, reason: 'x' });
    expect(replay).toMatchObject({ changed: false, replayed: true, status: 'released' });
  });

  it('B10 回归：authorize 对终态单重放 → state_conflict（released / settlement_pending 旧语义锁死）', async () => {
    // released：request.failed 三路释放后，同键同参再授权不是幂等重放而是拒绝
    const failed = await authorized();
    await failed.api.signal({ type: 'request.failed', requestId: failed.requestId, reason: 'x' });
    const afterReleased = await rejection(() =>
      failed.api.authorize({
        requestId: failed.requestId,
        userId: failed.userId,
        stream: true,
        quote: quote('2', '0'),
        reservationLimit: '10',
        authorizationTtlMs: TTL,
      }),
    );
    expect(afterReleased.code).toBe('billing.state_conflict');

    // settlement_pending：收据验收转待结算后重放同样拒绝
    const done = await authorized();
    await done.api.signal({
      type: 'request.succeeded',
      requestId: done.requestId,
      receipt: {
        requestId: done.requestId,
        userId: done.userId,
        apiKeyId: null,
        appId: null,
        credentialType: 'key',
        externalModel: 'm',
        realModel: 'm',
        channelId: null,
        channelKey: 't',
        usage: { inputTokens: 500_000, cachedInputTokens: 0, outputTokens: 0, estimated: false },
        inputPrice: '2',
        outputPrice: '0',
        cacheInputPrice: '0',
        coefficient: '1',
        durationMs: 10,
        stream: true,
        streamAborted: false,
        mappingId: 1,
        billingPolicyFingerprint: null,
      },
    });
    const afterPending = await rejection(() =>
      done.api.authorize({
        requestId: done.requestId,
        userId: done.userId,
        stream: true,
        quote: quote('2', '0'),
        reservationLimit: '10',
        authorizationTtlMs: TTL,
      }),
    );
    expect(afterPending.code).toBe('billing.state_conflict');
  });

  it('首次交付的错用户收据 → receipt_user_mismatch（毒收据家族）', async () => {
    const { api, requestId, userId } = await authorized();
    const rejected = await rejection(() =>
      api.signal({
        type: 'request.succeeded',
        requestId,
        receipt: {
          requestId,
          userId: userId + 1,
          apiKeyId: null,
          appId: null,
          credentialType: 'key',
          externalModel: 'm',
          realModel: 'm',
          channelId: null,
          channelKey: 't',
          usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, estimated: false },
          inputPrice: '2',
          outputPrice: '0',
          cacheInputPrice: '0',
          coefficient: '1',
          durationMs: 10,
          stream: true,
          streamAborted: false,
          mappingId: 1,
          billingPolicyFingerprint: null,
        },
      }),
    );
    expect(rejected.code).toBe('billing.receipt_user_mismatch');
  });

  it('request.failed：CAS → released + 三路预扣释放（钱包在途归还、订阅 reserved 归还）', async () => {
    const { api, wallet, world, requestId, userId } = await authorized();
    const released = await api.signal({
      type: 'request.failed',
      requestId,
      reason: 'upstream_error',
    });
    expect(released).toMatchObject({ changed: true, status: 'released', amountReleased: '2' });
    expect(defined((await wallet.accounts(userId))[0]).inFlight).toBe('0');
    const row = await world.billing.read((conn) => world.billing.findByRequestId(conn, requestId));
    expect(defined(row).status).toBe('released');
    // 已释放不可再成功
    const rejected = await rejection(() =>
      api.signal({
        type: 'request.succeeded',
        requestId,
        receipt: {
          requestId,
          userId,
          apiKeyId: null,
          appId: null,
          credentialType: 'key',
          externalModel: 'm',
          realModel: 'm',
          channelId: null,
          channelKey: 't',
          usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, estimated: false },
          inputPrice: '2',
          outputPrice: '0',
          cacheInputPrice: '0',
          coefficient: '1',
          durationMs: 10,
          stream: true,
          streamAborted: false,
          mappingId: 1,
          billingPolicyFingerprint: null,
        },
      }),
    );
    expect(rejected.code).toBe('billing.state_conflict');
  });
});

describe('reserveChannel（渠道敞口三模式）', () => {
  async function withChannel() {
    const h = harness();
    const userId = nextUser();
    await h.wallet.credit({ userId, amount: '100', refType: 'topup', refId: `ch-${userId}` });
    const requestId = nextRequestId();
    await h.api.authorize({
      requestId,
      userId,
      stream: false,
      quote: quote('2', '0'),
      reservationLimit: '100',
      authorizationTtlMs: TTL,
    });
    const channelId = seedChannel(h.world);
    return { ...h, requestId, channelId };
  }

  it('switch：预留新渠道并认领投影；再切回走 covered', async () => {
    const { api, world, requestId, channelId } = await withChannel();
    const result = await api.reserveChannel({ requestId, channelId, amount: '1' });
    expect(result).toMatchObject({ allowed: true, switched: false });
    expect(defined(world.fixtures.channelsMap.get(channelId)).upstreamReserved).toBe('1');
    // 同渠道同额 = covered（零变更）
    const covered = await api.reserveChannel({ requestId, channelId, amount: '1' });
    expect(covered).toMatchObject({ allowed: true, switched: false });
    // 同渠道更高预估 = topup 差额补足
    const topup = await api.reserveChannel({ requestId, channelId, amount: '1.5' });
    expect(topup.allowed).toBe(true);
    expect(defined(world.fixtures.channelsMap.get(channelId)).upstreamReserved).toBe('1.5');
  });

  it('换渠道：预留新 → 释放旧 → CAS 认领（switched=true，旧敞口归零）', async () => {
    const { api, world, requestId } = await withChannel();
    const a = seedChannel(world);
    const b = seedChannel(world);
    await api.reserveChannel({ requestId, channelId: a, amount: '2' });
    const switched = await api.reserveChannel({ requestId, channelId: b, amount: '1' });
    expect(switched).toMatchObject({ allowed: true, switched: true });
    expect(defined(world.fixtures.channelsMap.get(a)).upstreamReserved).toBe('0');
    expect(defined(world.fixtures.channelsMap.get(b)).upstreamReserved).toBe('1');
  });

  it('预算不足：零变更拒绝并回余量', async () => {
    const { api, world, requestId } = await withChannel();
    const small = seedChannel(world, { upstreamBudget: '0.5' });
    const result = await api.reserveChannel({ requestId, channelId: small, amount: '1' });
    expect(result).toMatchObject({ allowed: false, remaining: '0.5', switched: false });
    expect(defined(world.fixtures.channelsMap.get(small)).upstreamReserved).toBe('0');
  });
});

describe('积压准入', () => {
  it('零堆积直通；超深关闸（settlement_backlog）', async () => {
    const h = harness();
    const admission = createBillingAdmission({
      store: h.world.billing,
      maxPending: 1,
      maxOldestPendingMs: 60_000,
      clock: () => new Date(),
    });
    await expect(admission()).resolves.toBeUndefined();
    const userId = nextUser();
    await h.wallet.credit({ userId, amount: '100', refType: 'topup', refId: 'adm' });
    const requestId = nextRequestId();
    await h.api.authorize({
      requestId,
      userId,
      stream: false,
      quote: quote('1', '0'),
      reservationLimit: '100',
      authorizationTtlMs: TTL,
    });
    // 手工转 pending + 追加第二笔，模拟积压（绕过 signal 的收据验收）
    defined(h.world.fixtures.requests.get(requestId)).status = 'settlement_pending';
    const requestId2 = nextRequestId();
    await h.api.authorize({
      requestId: requestId2,
      userId,
      stream: false,
      quote: quote('1', '0'),
      reservationLimit: '100',
      authorizationTtlMs: TTL,
    });
    defined(h.world.fixtures.requests.get(requestId2)).status = 'settlement_pending';
    await expect(admission()).rejects.toMatchObject({ code: 'billing.settlement_backlog' });
  });

  it('过老关闸：最老 pending 账龄超限（oldestPendingMs 分支）', async () => {
    const h = harness();
    const admission = createBillingAdmission({
      store: h.world.billing,
      maxPending: 100,
      maxOldestPendingMs: 60_000,
      clock: () => new Date(),
    });
    const userId = nextUser();
    await h.wallet.credit({ userId, amount: '100', refType: 'topup', refId: 'adm2' });
    const requestId = nextRequestId();
    await h.api.authorize({
      requestId,
      userId,
      stream: false,
      quote: quote('1', '0'),
      reservationLimit: '100',
      authorizationTtlMs: TTL,
    });
    const row = defined(h.world.fixtures.requests.get(requestId));
    row.status = 'settlement_pending';
    row.createdAt = new Date(Date.now() - 120_000);
    await expect(admission()).rejects.toMatchObject({ code: 'billing.settlement_backlog' });
  });
});
