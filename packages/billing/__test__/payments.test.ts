/**
 * 支付与兑换契约测试（内存 stand-in + 内存 provider；迁移自旧仓 client-api payments/
 * redeem 服务测试主干；协议规则直测自 domain/payment）。
 */
import { describe, expect, it } from 'vitest';
import { isBusinessError } from '@tillgate/errors';
import { createHmac } from 'node:crypto';
import { createWalletApi } from '../src/application/wallet/wallet.js';
import { createPaymentsApi } from '../src/application/payments/payments.js';
import { createRedemptionApi, sha256Hex } from '../src/application/redemption/redemption.js';
import { createInMemoryWalletStore } from '../src/testing/in-memory-wallet-store.js';
import { createInMemoryBillingWorld } from '../src/testing/in-memory-billing-store.js';
import {
  createInMemoryPaymentStores,
  createInMemoryRateCounter,
} from '../src/testing/in-memory-payment-stores.js';
import type { PaymentProviderPort } from '../src/ports/payment-ports.js';
import { epaySign, epayVerify, parseEpayNotify } from '../src/domain/payment/epay.js';
import {
  parseStripeEvent,
  stripeMinorUnitsFromAmount,
  stripeAmountFromMinorUnits,
  verifyStripeSignature,
} from '../src/domain/payment/stripe.js';
import {
  assertTopupWithinLimit,
  amountsMatch,
  computeCreditAmount,
} from '../src/domain/payment/topup.js';
import { defined } from './defined.js';

let userSeq = 2500;
const nextUser = () => (userSeq += 1);

/** 可编程假渠道：内存 createOrder + 受控 notify 载荷 */
function fakeProvider(
  name: 'epay' | 'stripe',
  behavior: { failCreate?: boolean } = {},
): PaymentProviderPort & {
  sessions: Map<string, string>; // orderId -> providerOrderId
} {
  const sessions = new Map<string, string>();
  return {
    name,
    sessions,
    async createOrder(input) {
      if (behavior.failCreate) throw new Error('channel down');
      const providerOrderId = `cs_${input.orderId}`;
      sessions.set(input.orderId, providerOrderId);
      return { providerOrderId, payUrl: `https://pay/${providerOrderId}` };
    },
    parseNotify(raw: Record<string, string>) {
      if (raw['force-fail'] === '1') return null;
      const providerOrderId = raw.providerOrderId ?? '';
      const paidAmount = raw.paidAmount ?? '';
      if (!providerOrderId || !paidAmount) return null;
      return {
        providerOrderId,
        merchantOrderId: raw.merchantOrderId || undefined,
        paidAmount,
      };
    },
  };
}

function harness(providers: readonly PaymentProviderPort[]) {
  const walletMemory = createInMemoryWalletStore();
  const wallet = createWalletApi({
    store: walletMemory.store,
    guards: {
      refTypes: ['billing', 'topup', 'admin', 'subscription', 'pack', 'redeem'],
      currencies: ['CNY'],
      internalAccounts: ['outside', 'platform_revenue'],
    },
    currency: 'CNY',
  });
  const world = createInMemoryBillingWorld();
  const paymentsMemory = createInMemoryPaymentStores();
  const limiter = createInMemoryRateCounter();
  const payments = createPaymentsApi({
    store: world.billing,
    orders: paymentsMemory.orderStore,
    wallet,
    providers,
    currency: 'CNY',
    exchangeRate: '1',
    topupMin: '1',
    topupMax: '1000',
    orderLimiter: limiter.counter,
    perMinuteOrderLimit: 6,
    orderTtlMs: 600_000,
    clock: () => new Date(),
    logError: () => {},
  });
  const redemption = createRedemptionApi({
    store: world.billing,
    codes: paymentsMemory.codeStore,
    wallet,
    limiter: limiter.counter,
    perMinuteLimit: 10,
    clock: () => new Date(),
  });
  return { wallet, world, payments, redemption, paymentsMemory, limiter };
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

describe('协议规则', () => {
  it('epay：键序 MD5 签名/验签（恒定时间）；载荷归一', () => {
    const params: Record<string, string> = {
      pid: '1001',
      out_trade_no: 'o1',
      money: '10',
      type: 'alipay',
    };
    params.sign = epaySign(params, 'key');
    expect(epayVerify(params, 'key')).toBe(true);
    expect(epayVerify({ ...params, sign: 'deadbeef' }, 'key')).toBe(false);
    expect(epayVerify({ ...params, sign: '' }, 'key')).toBe(false);
    expect(
      parseEpayNotify({ out_trade_no: 'o1', trade_status: 'TRADE_SUCCESS', money: '10' }),
    ).toEqual({
      providerOrderId: 'o1',
      tradeStatus: 'TRADE_SUCCESS',
      amount: '10',
    });
    expect(parseEpayNotify({})).toBeNull();
  });

  it('stripe：单位转换（两位小数 ×100）/ 验签（时间窗+恒定时间）/ 事件归一（paid+mode+currency 三闸）', () => {
    expect(stripeMinorUnitsFromAmount('10.10', 'cny')).toBe('1010');
    expect(stripeAmountFromMinorUnits(1010, 'cny')).toBe('10.10');
    const now = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({ type: 'checkout.session.completed' });
    const sig = createHmac('sha256', 'whsec_x').update(`${now}.${payload}`).digest('hex');
    expect(verifyStripeSignature(`t=${now},v1=${sig}`, payload, 'whsec_x', now * 1000)).toBe(true);
    expect(verifyStripeSignature(`t=${now - 4000},v1=${sig}`, payload, 'whsec_x', now * 1000)).toBe(
      false,
    );
    const event = parseStripeEvent(
      JSON.stringify({
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_1',
            client_reference_id: 'o1',
            amount_total: 1010,
            payment_status: 'paid',
            mode: 'payment',
            currency: 'CNY',
          },
        },
      }),
      'CNY',
    );
    expect(event).toEqual({ sessionId: 'cs_1', orderId: 'o1', paidAmount: '10.10' });
    // unpaid / 非 cny / 垃圾 JSON 拒收
    expect(
      parseStripeEvent(
        JSON.stringify({
          type: 'checkout.session.completed',
          data: {
            object: {
              id: 'x',
              client_reference_id: 'o',
              amount_total: 1,
              payment_status: 'unpaid',
              mode: 'payment',
              currency: 'cny',
            },
          },
        }),
        'CNY',
      ),
    ).toBeNull();
    expect(parseStripeEvent('not-json', 'CNY')).toBeNull();
  });

  it('topup 规则：面额闸（两位小数/min/max）、汇率入账、金额核对', () => {
    expect(() => assertTopupWithinLimit('10', '1', '1000')).not.toThrow();
    expect(() => assertTopupWithinLimit('10.999', '1', '1000')).toThrow();
    expect(() => assertTopupWithinLimit('0.5', '1', '1000')).toThrow();
    expect(() => assertTopupWithinLimit('2000', '1', '1000')).toThrow();
    expect(computeCreditAmount('10.5', '7.1')).toBe('74.55');
    expect(amountsMatch('10.00', '10')).toBe(true);
    expect(amountsMatch('10.01', '10')).toBe(false);
    expect(amountsMatch('abc', '10')).toBe(false);
  });
});

describe('支付下单与回调', () => {
  it('下单 → 先落库再建渠道会话 → 回填单号；回调单事务入账（重复回调幂等）', async () => {
    const provider = fakeProvider('stripe');
    const { wallet, payments, paymentsMemory } = harness([provider]);
    const userId = nextUser();
    const order = await payments.createTopupOrder(userId, { amount: '10' });
    expect(order.creditAmount).toBe('10');
    const row = defined(paymentsMemory.orders.get(order.orderId));
    expect(row.providerOrderId).toBe(`cs_${order.orderId}`); // 回填生效
    // 金额不符拒收
    expect(
      await payments.handleNotify('stripe', {
        providerOrderId: row.providerOrderId,
        paidAmount: '9.99',
      }),
    ).toBe('fail');
    // 验签通过（假渠道）金额一致 → 入账
    const ok = await payments.handleNotify('stripe', {
      providerOrderId: row.providerOrderId,
      paidAmount: '10',
    });
    expect(ok).toBe('success');
    expect(defined((await wallet.accounts(userId))[0]).balance).toBe('10');
    expect(defined(paymentsMemory.orders.get(order.orderId)).status).toBe(2);
    // 重复回调幂等成功应答，不重复入账
    expect(
      await payments.handleNotify('stripe', {
        providerOrderId: row.providerOrderId,
        paidAmount: '10',
      }),
    ).toBe('success');
    expect(defined((await wallet.accounts(userId))[0]).balance).toBe('10');
  });

  it('渠道下单失败：关单留痕（0→4）+ payment_channel_unavailable', async () => {
    const provider = fakeProvider('stripe', { failCreate: true });
    const { payments, paymentsMemory } = harness([provider]);
    const userId = nextUser();
    const rejected = await rejection(() => payments.createTopupOrder(userId, { amount: '10' }));
    expect(rejected.code).toBe('billing.payment_channel_unavailable');
    const [row] = [...paymentsMemory.orders.values()];
    expect(defined(row).status).toBe(4);
  });

  it('过期单复活：已付款的关单标记（4→1→2）不搁浅资金', async () => {
    const provider = fakeProvider('stripe');
    const { wallet, payments, paymentsMemory } = harness([provider]);
    const userId = nextUser();
    const order = await payments.createTopupOrder(userId, { amount: '10' });
    defined(paymentsMemory.orders.get(order.orderId)).status = 4; // 模拟 TTL 误关
    const ok = await payments.handleNotify('stripe', {
      providerOrderId: `cs_${order.orderId}`,
      paidAmount: '10',
    });
    expect(ok).toBe('success');
    expect(defined((await wallet.accounts(userId))[0]).balance).toBe('10');
    expect(defined(paymentsMemory.orders.get(order.orderId)).status).toBe(2);
  });

  it('Stripe 回退锚：attach 缺席时按商户单号定位（不认领已绑定他人会话的单）', async () => {
    const provider = fakeProvider('stripe');
    const { payments, paymentsMemory } = harness([provider]);
    const userId = nextUser();
    const order = await payments.createTopupOrder(userId, { amount: '10' });
    // 模拟 attach 失败：providerOrderId 仍是占位
    defined(paymentsMemory.orders.get(order.orderId)).providerOrderId = order.orderId;
    const ok = await payments.handleNotify('stripe', {
      providerOrderId: 'cs_unknown',
      merchantOrderId: order.orderId,
      paidAmount: '10',
    });
    expect(ok).toBe('success');
  });

  it('面额闸与下单频率闸（超限 429；计数器不可达 fail-closed）', async () => {
    const provider = fakeProvider('epay');
    const h = harness([provider]);
    const userId = nextUser();
    expect(
      (await rejection(() => h.payments.createTopupOrder(userId, { amount: '0.5' }))).code,
    ).toBe('billing.topup_amount_invalid');
    for (let i = 0; i < 5; i += 1) {
      await h.payments.createTopupOrder(userId, { amount: '10' });
    }
    expect(
      (await rejection(() => h.payments.createTopupOrder(userId, { amount: '10' }))).code,
    ).toBe('billing.topup_rate_limited');
    const broken = createInMemoryRateCounter(0);
    const strict = createPaymentsApi({
      store: h.world.billing,
      orders: h.paymentsMemory.orderStore,
      wallet: h.wallet,
      providers: [provider],
      currency: 'CNY',
      exchangeRate: '1',
      topupMin: '1',
      topupMax: '1000',
      orderLimiter: broken.counter,
      perMinuteOrderLimit: 6,
      orderTtlMs: 600_000,
      clock: () => new Date(),
      logError: () => {},
    });
    expect(
      (await rejection(() => strict.createTopupOrder(nextUser(), { amount: '10' }))).code,
    ).toBe('billing.rate_counter_unavailable');
  });
});

describe('兑换码', () => {
  it('核销与入账同事务；错误语义区分（无效/已用/吊销/过期）+ 频率闸', async () => {
    const { wallet, redemption, paymentsMemory, limiter } = harness([fakeProvider('epay')]);
    const userId = nextUser();
    const codeHash = sha256Hex('GOLD-2026');
    await paymentsMemory.codeStore.insertBatchWithCodes({} as never, {
      batchName: '开服',
      amount: '5',
      expiresAt: new Date(Date.now() + 86_400_000),
      createdBy: 1,
      codeHashes: [codeHash],
    });
    const redeemed = await redemption.redeem(userId, { code: 'GOLD-2026' });
    expect(redeemed).toMatchObject({ amount: '5', balanceAfter: '5' });
    // 已用
    expect((await rejection(() => redemption.redeem(userId, { code: 'GOLD-2026' }))).code).toBe(
      'billing.code_already_used',
    );
    // 无效
    expect((await rejection(() => redemption.redeem(userId, { code: 'NOPE' }))).code).toBe(
      'billing.invalid_code',
    );
    // 空码
    expect((await rejection(() => redemption.redeem(userId, { code: '  ' }))).code).toBe(
      'billing.invalid_code',
    );
    // 吊销
    const revokedHash = sha256Hex('REVOKED');
    await paymentsMemory.codeStore.insertBatchWithCodes({} as never, {
      batchName: '撤回',
      amount: '1',
      expiresAt: null,
      createdBy: 1,
      codeHashes: [revokedHash],
    });
    defined(paymentsMemory.codes.get(revokedHash)).status = 2;
    expect((await rejection(() => redemption.redeem(userId, { code: 'REVOKED' }))).code).toBe(
      'billing.code_revoked',
    );
    // 过期
    const expiredHash = sha256Hex('EXPIRED');
    await paymentsMemory.codeStore.insertBatchWithCodes({} as never, {
      batchName: '过期',
      amount: '1',
      expiresAt: new Date(Date.now() - 1000),
      createdBy: 1,
      codeHashes: [expiredHash],
    });
    expect((await rejection(() => redemption.redeem(userId, { code: 'EXPIRED' }))).code).toBe(
      'billing.code_expired',
    );
    // 频率闸：超过 perMinuteLimit
    limiter.reset();
    const spam = createInMemoryRateCounter();
    const strict = createRedemptionApi({
      store: (
        await import('../src/testing/in-memory-billing-store.js')
      ).createInMemoryBillingWorld().billing,
      codes: paymentsMemory.codeStore,
      wallet,
      limiter: spam.counter,
      perMinuteLimit: 2,
      clock: () => new Date(),
    });
    const spammer = nextUser();
    await strict.redeem(spammer, { code: 'NOPE' }).catch(() => {});
    await strict.redeem(spammer, { code: 'NOPE' }).catch(() => {});
    expect((await rejection(() => strict.redeem(spammer, { code: 'NOPE' }))).code).toBe(
      'billing.redeem_rate_limited',
    );
    void wallet;
  });
});

describe('订单读侧与渠道清单', () => {
  it('orderDetail（本人/他人不可见）、listOrders 机会式关单、channels 清单', async () => {
    const provider = fakeProvider('stripe');
    const { payments, paymentsMemory } = harness([provider]);
    const userId = nextUser();
    const order = await payments.createTopupOrder(userId, { amount: '10' });
    const detail = await payments.orderDetail(userId, order.orderId);
    expect(detail.amount).toBe('10');
    expect((await rejection(() => payments.orderDetail(nextUser(), order.orderId))).code).toBe(
      'billing.order_not_found',
    );
    // 机会式关单：把创建时间拨回 TTL 之前，listOrders 触发关单
    defined(paymentsMemory.orders.get(order.orderId)).createdAt = new Date(Date.now() - 700_000);
    const list = await payments.listOrders(userId, { page: 1, limit: 10 });
    expect(defined(list[0]).status).toBe(4);
    expect(payments.channels()).toEqual([{ id: 'stripe', label: 'Stripe' }]);
  });

  it('兑换历史与计数器不可达 fail-closed', async () => {
    const provider = fakeProvider('epay');
    const { wallet, redemption, paymentsMemory } = harness([provider]);
    const userId = nextUser();
    const codeHash = sha256Hex('HIST-1');
    await paymentsMemory.codeStore.insertBatchWithCodes({} as never, {
      batchName: '历史批',
      amount: '3',
      expiresAt: null,
      createdBy: 1,
      codeHashes: [codeHash],
    });
    await redemption.redeem(userId, { code: 'HIST-1' });
    const history = await redemption.history(userId, { page: 1, limit: 10 });
    expect(history).toMatchObject([{ batchName: '历史批', amount: '3' }]);
    const broken = createInMemoryRateCounter(0);
    const strict = createRedemptionApi({
      store: createInMemoryBillingWorld().billing,
      codes: paymentsMemory.codeStore,
      wallet,
      limiter: broken.counter,
      perMinuteLimit: 10,
      clock: () => new Date(),
    });
    expect((await rejection(() => strict.redeem(nextUser(), { code: 'X' }))).code).toBe(
      'billing.rate_counter_unavailable',
    );
  });
});

const stripeEvent = (type: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type,
    data: {
      object: {
        id: 'cs_9',
        amount_total: 500,
        payment_status: 'paid',
        mode: 'payment',
        currency: 'cny',
        ...extra,
      },
    },
  });

describe('回调分支封口', () => {
  it('未知渠道 / 验签拒收 / 订单不存在 → fail（零副作用）', async () => {
    const provider = fakeProvider('stripe');
    const { wallet, payments } = harness([provider]);
    expect(await payments.handleNotify('wechat', {})).toBe('fail');
    expect(
      await payments.handleNotify('stripe', {
        'force-fail': '1',
        providerOrderId: 'x',
        paidAmount: '1',
      }),
    ).toBe('fail');
    expect(
      await payments.handleNotify('stripe', { providerOrderId: 'ghost', paidAmount: '1' }),
    ).toBe('fail');
    expect((await wallet.accounts(nextUser())).length).toBe(0);
  });

  it('并发回调竞态：markPaid 输家重读后 credited 幂等返回；非 1/2/4 态拒收', async () => {
    const provider = fakeProvider('stripe');
    const { payments, paymentsMemory } = harness([provider]);
    const userId = nextUser();
    const order = await payments.createTopupOrder(userId, { amount: '10' });
    const raw = { providerOrderId: `cs_${order.orderId}`, paidAmount: '10' };
    // 并发双回调：内存串行——第一个成功；第二个走「已 credited 幂等」
    expect(await payments.handleNotify('stripe', raw)).toBe('success');
    expect(await payments.handleNotify('stripe', raw)).toBe('success');
    // 非 1/2/4 态（构造 status=0 但 markPaid 被抢——直接置 3 非法态模拟守卫失败）
    const order2 = await payments.createTopupOrder(userId, { amount: '10' });
    defined(paymentsMemory.orders.get(order2.orderId)).status = 99;
    expect(
      await payments.handleNotify('stripe', {
        providerOrderId: `cs_${order2.orderId}`,
        paidAmount: '10',
      }),
    ).toBe('fail');
  });

  it('isValidAmountInput 结构性闸（科学计数法/垃圾/合法）', async () => {
    const { isValidAmountInput } = await import('../src/domain/payment/topup.js');
    expect(isValidAmountInput('10.5')).toBe(true);
    expect(isValidAmountInput('1e-20')).toBe(false); // 科学计数法规范化后超尺度
    expect(isValidAmountInput('abc')).toBe(false);
    expect(isValidAmountInput('-1')).toBe(false);
  });

  it('stripe async_payment_succeeded 事件族与 metadata 回退锚', async () => {
    expect(
      parseStripeEvent(
        stripeEvent('checkout.session.async_payment_succeeded', { client_reference_id: 'o9' }),
        'CNY',
      ),
    ).toMatchObject({ sessionId: 'cs_9', orderId: 'o9', paidAmount: '5.00' });
    expect(parseStripeEvent(stripeEvent('checkout.session.expired'), 'CNY')).toBeNull();
    // client_reference_id 缺席时走 metadata.order_id
    expect(
      parseStripeEvent(
        stripeEvent('checkout.session.completed', { metadata: { order_id: 'via-meta' } }),
        'CNY',
      ),
    ).toMatchObject({ orderId: 'via-meta' });
  });
});

describe('渠道适配器配置（币种/支付类型单真相）', () => {
  it('epay：payType 必填且经 EPAY_PAY_TYPES 词表校验；下单参数携带配置值', async () => {
    const { createEpayProvider } = await import('../src/adapters/payments/providers.js');
    const provider = createEpayProvider({
      pid: '1001',
      key: 'key',
      gatewayUrl: 'https://epay.example/submit.php',
      notifyUrl: 'https://app.example/notify',
      returnUrl: 'https://app.example/return',
      payType: 'wxpay',
    });
    const order = await provider.createOrder({ orderId: 'o-1', amount: '10', subject: '充值' });
    expect(order.payUrl).toContain('type=wxpay');
    expect(order.payUrl).not.toContain('type=alipay');
    expect(order.providerOrderId).toBe('o-1');
    // 词表外值：装配即拒（英文 message）
    expect(() =>
      createEpayProvider({
        pid: '1001',
        key: 'key',
        gatewayUrl: 'https://epay.example/submit.php',
        notifyUrl: 'https://app.example/notify',
        returnUrl: 'https://app.example/return',
        payType: 'crypto' as never,
      }),
    ).toThrow(/epay pay type not supported/);
  });

  it('stripe：currency 必填注入——下单 body 与回调币种闸同源（USD 单拒收 CNY 事件）', async () => {
    const { createStripeProvider } = await import('../src/adapters/payments/providers.js');
    let capturedBody = '';
    const provider = createStripeProvider({
      secretKey: 'sk_test',
      webhookSecret: 'whsec_x',
      successUrl: 'https://app.example/ok',
      cancelUrl: 'https://app.example/cancel',
      currency: 'CNY',
      apiBase: 'https://stripe.test',
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        capturedBody = String(init?.body);
        return new Response(JSON.stringify({ id: 'cs_1', url: 'https://pay/cs_1' }), {
          status: 200,
        });
      }) as typeof fetch,
      clock: () => Math.floor(Date.now() / 1000) * 1000,
    });
    const order = await provider.createOrder({ orderId: 'o-2', amount: '10.10', subject: '充值' });
    expect(order.providerOrderId).toBe('cs_1');
    expect(capturedBody).toContain('currency%5D=cny'); // 注入币种（非写死;line_items[price_data][currency] 的 URL 编码形态）
    expect(capturedBody).toContain('unit_amount%5D=1010');
    // 回调币种闸：注入 CNY → USD 事件拒收；CNY 事件放行
    const nowSec = Math.floor(Date.now() / 1000);
    const eventOf = (currency: string) => {
      const payload = JSON.stringify({
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_9',
            client_reference_id: 'o-2',
            amount_total: 1010,
            payment_status: 'paid',
            mode: 'payment',
            currency,
          },
        },
      });
      const sig = createHmac('sha256', 'whsec_x').update(`${nowSec}.${payload}`).digest('hex');
      return provider.parseNotify({ payload, 'stripe-signature': `t=${nowSec},v1=${sig}` });
    };
    expect(eventOf('usd')).toBeNull(); // 币种错配拒收（资损闸）
    expect(eventOf('CNY')).toMatchObject({ providerOrderId: 'cs_9', paidAmount: '10.10' });
  });

  it('stripeMinorUnitsFromAmount 零 round：非整单位值结构性拒绝（不静默取整）', () => {
    expect(stripeMinorUnitsFromAmount('10.10', 'cny')).toBe('1010');
    expect(() => stripeMinorUnitsFromAmount('10.005', 'cny')).toThrow(/whole minor units/);
  });
  it('stripe 零小数币种（词表）：amount 即主币种单位——统一 ×100 会实收 100 倍（审计 #6 回归）', () => {
    // 下单 1000 JPY → unit_amount 1000（日元单位）；回调 amount_total 1000 → '1000'，amountsMatch 对称通过
    expect(stripeMinorUnitsFromAmount('1000', 'jpy')).toBe('1000');
    expect(stripeAmountFromMinorUnits(1000, 'jpy')).toBe('1000');
    expect(stripeMinorUnitsFromAmount('1000', 'JPY')).toBe('1000'); // 大小写归一
    // 零小数币种带小数 → 非整单位结构性拒绝
    expect(() => stripeMinorUnitsFromAmount('1000.50', 'krw')).toThrow(/whole minor units/);
    // 两位小数币种不受词表影响
    expect(stripeMinorUnitsFromAmount('1000.50', 'cny')).toBe('100050');
  });
});

describe('多渠道装配', () => {
  it('未显式选择且多渠道启用 → payment_unavailable；显式命中放行', async () => {
    const { payments } = harness([fakeProvider('epay'), fakeProvider('stripe')]);
    const rejected = await rejection(() => payments.createTopupOrder(nextUser(), { amount: '10' }));
    expect(rejected.code).toBe('billing.payment_unavailable');
    const order = await payments.createTopupOrder(nextUser(), { amount: '10', provider: 'epay' });
    expect(order.payUrl).toContain('https://pay/');
  });
});
