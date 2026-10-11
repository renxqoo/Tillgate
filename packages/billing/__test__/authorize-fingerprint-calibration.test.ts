/**
 * authorize 指纹的 calibration 排除测试（docs §3.2a / v3-R3）：
 * quote.calibration 是时变实测值（inputTokens 随收据变），不得参与命令身份
 * ——同 requestId 重放即使 calibration 快照值漂移也必须幂等（不得 state_conflict）。
 */
import { describe, expect, it } from 'vitest';
import { createWalletApi } from '../src/application/wallet/wallet.js';
import { createBillingApi } from '../src/application/billing/billing.js';
import { createInMemoryWalletStore } from '../src/testing/in-memory-wallet-store.js';
import { createInMemoryBillingWorld } from '../src/testing/in-memory-billing-store.js';
import type { BillingQuote } from '../src/domain/rating/types.js';

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
  return { wallet, world, api };
}

function calibratedQuote(calibration: NonNullable<BillingQuote['calibration']>): BillingQuote {
  return {
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
    calibration,
  };
}

let userSeq = 6700;
let reqSeq = 0;
const nextUser = () => (userSeq += 1);
const nextRequestId = () => {
  const n = (reqSeq += 1);
  const hex = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}${'0'.repeat(12 - hex.length)}`.slice(0, 36);
};

describe('指纹排除 calibration（v3-R3）', () => {
  it('同 requestId 重放、calibration 快照值漂移 → 幂等重放（非 state_conflict）', async () => {
    const { wallet, api } = harness();
    const userId = nextUser();
    await wallet.credit({ userId, amount: '10', refType: 'topup', refId: 'c1' });
    const requestId = nextRequestId();
    const first = await api.authorize({
      requestId,
      userId,
      stream: false,
      quote: calibratedQuote({
        mappingId: 13,
        prefixHash: 'aaa',
        channelId: 8,
        inputTokens: 50_000, // 第一笔的 seen
        messagesLen: 2,
        prefixBytes: 180_000,
        cacheRatio: 0.9,
      }),
      reservationLimit: '10',
      authorizationTtlMs: 60_000,
    });
    expect(first.replayed).toBe(false);
    // 重放时校准记录已被并发结算覆盖（seen 变了）——命令身份不变必须幂等
    const replay = await api.authorize({
      requestId,
      userId,
      stream: false,
      quote: calibratedQuote({
        mappingId: 13,
        prefixHash: 'aaa',
        channelId: 8,
        inputTokens: 48_500, // 并发结算覆盖后的新 seen
        messagesLen: 2,
        prefixBytes: 180_000,
        cacheRatio: 0.9,
      }),
      reservationLimit: '10',
      authorizationTtlMs: 60_000,
    });
    expect(replay.replayed).toBe(true);
  });

  it('quote 其它字段变化（价格）仍拒绝（排除面只限 calibration）', async () => {
    const { wallet, api } = harness();
    const userId = nextUser();
    await wallet.credit({ userId, amount: '10', refType: 'topup', refId: 'c2' });
    const requestId = nextRequestId();
    await api.authorize({
      requestId,
      userId,
      stream: false,
      quote: calibratedQuote({
        mappingId: 13,
        prefixHash: 'aaa',
        channelId: 8,
        inputTokens: 50_000,
        messagesLen: 2,
        prefixBytes: 180_000,
        cacheRatio: 0.9,
      }),
      reservationLimit: '10',
      authorizationTtlMs: 60_000,
    });
    const drifted = calibratedQuote({
      mappingId: 13,
      prefixHash: 'aaa',
      channelId: 8,
      inputTokens: 50_000,
      messagesLen: 2,
      prefixBytes: 180_000,
      cacheRatio: 0.9,
    });
    drifted.candidates[0]!.inputPrice = '3'; // 价格变化 = 命令身份变化
    await expect(
      api.authorize({
        requestId,
        userId,
        stream: false,
        quote: drifted,
        reservationLimit: '10',
        authorizationTtlMs: 60_000,
      }),
    ).rejects.toMatchObject({ code: 'billing.state_conflict' });
  });
});
