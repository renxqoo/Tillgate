/**
 * 充值支付集成套件（真 PG + 本地 epay/stripe 适配器）：
 * 面单闸 / 下单签名 / 回调验签 / 金额核对 / 幂等重放 / 状态机 CAS / 多渠道选择。
 * 资损不变量：重复回调、并发回调、金额篡改（签名合法）都不产生第二笔或超额入账。
 * Stripe 上游以注入 fetch 模拟（Checkout Session 创建 + webhook 事件验签走真 HMAC）。
 */
import { createHmac, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { paymentOrders } from '@ai-gateway/db';
import { describe, expect, it } from 'vitest';
import { systemContext } from '@ai-gateway/service';
import {
  createEpayProvider,
  createPaymentsService,
  createStripeProvider,
  type PaymentProviderPort,
} from '../services/payments.service.js';
import { epaySign } from '../domain/epay.js';
import {
  balanceOf,
  db,
  expectAmountEq,
  newUser,
  wallet,
} from './helpers.js';
import { createRepositories } from '@ai-gateway/repository';

const ctx = systemContext('cav2-pay');
const EPAY = {
  pid: '1001',
  key: 'test-epay-key',
  gatewayUrl: 'https://pay.example.com/submit.php',
  notifyUrl: 'https://api.example.com/v1/payments/notify/epay',
  returnUrl: 'https://console.example.com/wallet',
};
const STRIPE = {
  secretKey: 'sk_test_cav2',
  webhookSecret: 'whsec_test_cav2',
  successUrl: 'https://console.example.com/billing?ok=1',
  cancelUrl: 'https://console.example.com/billing?cancel=1',
};
const repos = createRepositories();

function buildService(
  providers: readonly PaymentProviderPort[] = [createEpayProvider(EPAY)],
  rate = '1',
) {
  return createPaymentsService({
    db,
    wallet,
    providers,
    currency: 'CNY',
    topupMin: '1',
    topupMax: '10000',
    exchangeRate: rate,
    orderTtlMs: 1_800_000,
  });
}

/** 构造一份「渠道会发的」合法易支付回调 query */
function signedNotify(orderId: string, money: string, overrides: Record<string, string> = {}) {
  const params: Record<string, string> = {
    pid: EPAY.pid,
    out_trade_no: orderId,
    trade_no: `channel-${orderId.slice(0, 8)}`,
    trade_status: 'TRADE_SUCCESS',
    money,
    ...overrides,
  };
  params.sign = epaySign(params, EPAY.key);
  params.sign_type = 'MD5';
  return params;
}

/** Stripe Checkout Session 模拟上游（捕获请求体；每单返回唯一 session id） */
function stripeUpstream() {
  const calls: Array<{ url: string; auth: string; body: URLSearchParams; sessionId: string }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const sessionId = `cs_test_${randomUUID().slice(0, 8)}`;
    calls.push({
      url: String(url),
      auth: ((init?.headers ?? {}) as Record<string, string>).authorization ?? '',
      body: new URLSearchParams(String(init?.body)),
      sessionId,
    });
    return new Response(
      JSON.stringify({ id: sessionId, url: `https://checkout.stripe.com/c/pay/${sessionId}` }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { calls, fetchImpl };
}

/** 构造一份「Stripe 会发的」合法 webhook 材料（真 HMAC 签名） */
function signedWebhook(input: {
  sessionId?: string;
  orderId: string;
  amountCents: number;
  secret?: string;
  timestampOffsetS?: number;
}) {
  const payload = JSON.stringify({
    type: 'checkout.session.completed',
    data: {
      object: {
        id: input.sessionId ?? 'cs_test_session',
        client_reference_id: input.orderId,
        amount_total: input.amountCents,
        payment_status: 'paid',
        mode: 'payment',
        currency: 'cny',
        metadata: { order_id: input.orderId },
      },
    },
  });
  const t = Math.floor(Date.now() / 1000) + (input.timestampOffsetS ?? 0);
  const v1 = createHmac('sha256', input.secret ?? STRIPE.webhookSecret)
    .update(`${t}.${payload}`)
    .digest('hex');
  return { payload, 'stripe-signature': `t=${t},v1=${v1}` };
}

describe('下单', () => {
  it('happy path：订单落库 status=0，payUrl 带签名参数，creditAmount=amount×汇率', async () => {
    const account = await newUser();
    const service = buildService(undefined, '1.5');
    const order = await service.createTopupOrder(ctx, account.id, { amount: '10' });
    expect(order.orderId).toBeTruthy();
    expect(order.payUrl.startsWith(EPAY.gatewayUrl)).toBe(true);
    expect(order.payUrl).toContain('out_trade_no=' + order.orderId);
    expect(order.payUrl).toContain('sign=');
    expectAmountEq(order.creditAmount, '15');
    const row = await repos.paymentOrder.findById(
      { db, requestId: 't', actor: { kind: 'system' }, traceParent: null },
      order.orderId,
    );
    expect(row!.status).toBe(0);
    expectAmountEq(row!.creditAmount, '15');
  });

  it('面额闸：低于下限/高于上限/畸形金额拒绝', async () => {
    const account = await newUser();
    const service = buildService();
    await expect(service.createTopupOrder(ctx, account.id, { amount: '0.5' })).rejects.toMatchObject({
      status: 400,
    });
    await expect(service.createTopupOrder(ctx, account.id, { amount: '20000' })).rejects.toMatchObject({
      status: 400,
    });
    await expect(service.createTopupOrder(ctx, account.id, { amount: 'NaN' })).rejects.toThrow();
  });

  it('渠道未配置 → 503；显式指定未启用渠道 → 503', async () => {
    const account = await newUser();
    const service = buildService([]);
    await expect(service.createTopupOrder(ctx, account.id, { amount: '10' })).rejects.toMatchObject({
      status: 503,
      code: 'payment_unavailable',
    });
    const epayOnly = buildService();
    await expect(
      epayOnly.createTopupOrder(ctx, account.id, { amount: '10', provider: 'stripe' }),
    ).rejects.toMatchObject({ status: 503, code: 'payment_unavailable' });
  });

  it('多渠道并存未显式选择 → 503（须前端指定）；channels() 双渠道带标签', async () => {
    const account = await newUser();
    const upstream = stripeUpstream();
    const service = buildService([
      createEpayProvider(EPAY),
      createStripeProvider({ ...STRIPE, fetchImpl: upstream.fetchImpl }),
    ]);
    await expect(service.createTopupOrder(ctx, account.id, { amount: '10' })).rejects.toMatchObject({
      status: 503,
    });
    expect(service.channels()).toEqual([
      { id: 'epay', label: '在线支付（支付宝/微信）' },
      { id: 'stripe', label: 'Stripe（国际卡）' },
    ]);
  });
});

describe('回调入账（资损不变量主战场）', () => {
  it('happy path：验签→金额核对→paid→credited，余额=creditAmount', async () => {
    const account = await newUser();
    const service = buildService(undefined, '2');
    const order = await service.createTopupOrder(ctx, account.id, { amount: '10' });
    const answer = await service.handleNotify(ctx, 'epay', signedNotify(order.orderId, '10'));
    expect(answer).toBe('success');
    expectAmountEq(await balanceOf(account.id), '20');
    const row = await repos.paymentOrder.findById(
      { db, requestId: 't', actor: { kind: 'system' }, traceParent: null },
      order.orderId,
    );
    expect(row!.status).toBe(2);
    expect(row!.paidAt).not.toBeNull();
    expect(row!.creditedAt).not.toBeNull();
  });

  it('重复回调：幂等 success，余额只入一次（refKey=orderId）', async () => {
    const account = await newUser();
    const service = buildService();
    const order = await service.createTopupOrder(ctx, account.id, { amount: '5' });
    await service.handleNotify(ctx, 'epay', signedNotify(order.orderId, '5'));
    for (let i = 0; i < 3; i++) {
      expect(await service.handleNotify(ctx, 'epay', signedNotify(order.orderId, '5'))).toBe('success');
    }
    expectAmountEq(await balanceOf(account.id), '5');
  });

  it('并发回调：仅一笔入账（CAS + wallet 唯一冲突兜底）', async () => {
    const account = await newUser();
    const service = buildService();
    const order = await service.createTopupOrder(ctx, account.id, { amount: '6' });
    const answers = await Promise.all([
      service.handleNotify(ctx, 'epay', signedNotify(order.orderId, '6')),
      service.handleNotify(ctx, 'epay', signedNotify(order.orderId, '6')),
      service.handleNotify(ctx, 'epay', signedNotify(order.orderId, '6')),
    ]);
    expect(answers.filter((a) => a === 'success').length).toBeGreaterThanOrEqual(1);
    expectAmountEq(await balanceOf(account.id), '6');
  });

  it('坏签名 → fail，订单停留 created、零入账', async () => {
    const account = await newUser();
    const service = buildService();
    const order = await service.createTopupOrder(ctx, account.id, { amount: '5' });
    const tampered = signedNotify(order.orderId, '5');
    tampered.sign = 'deadbeef'.repeat(8);
    expect(await service.handleNotify(ctx, 'epay', tampered)).toBe('fail');
    expectAmountEq(await balanceOf(account.id), '0');
    const row = await repos.paymentOrder.findById(
      { db, requestId: 't', actor: { kind: 'system' }, traceParent: null },
      order.orderId,
    );
    expect(row!.status).toBe(0);
  });

  it('易支付 pid 不属于本商户，即使共享密钥签名合法也拒绝', async () => {
    const account = await newUser();
    const service = buildService();
    const order = await service.createTopupOrder(ctx, account.id, { amount: '5' });
    expect(
      await service.handleNotify(ctx, 'epay', signedNotify(order.orderId, '5', { pid: 'other-merchant' })),
    ).toBe('fail');
    expectAmountEq(await balanceOf(account.id), '0');
  });

  it('金额篡改（签名合法但 money 少于订单）→ fail，零入账', async () => {
    const account = await newUser();
    const service = buildService();
    const order = await service.createTopupOrder(ctx, account.id, { amount: '100' });
    // 用真密钥签一份 money=0.01 的回调——签名验证通过，金额闸拒绝
    expect(await service.handleNotify(ctx, 'epay', signedNotify(order.orderId, '0.01'))).toBe('fail');
    expectAmountEq(await balanceOf(account.id), '0');
  });

  it('状态非 TRADE_SUCCESS → fail；未知订单 → fail', async () => {
    const account = await newUser();
    const service = buildService();
    const order = await service.createTopupOrder(ctx, account.id, { amount: '5' });
    const notPaid = signedNotify(order.orderId, '5', { trade_status: 'WAIT_BUYER_PAY' });
    expect(await service.handleNotify(ctx, 'epay', notPaid)).toBe('fail');
    expect(await service.handleNotify(ctx, 'epay', signedNotify('00000000-0000-0000-0000-000000000000', '5'))).toBe(
      'fail',
    );
  });
});

describe('Stripe 渠道（下单 + webhook 入账）', () => {
  function stripeService(rate = '1') {
    const upstream = stripeUpstream();
    const service = buildService([createStripeProvider({ ...STRIPE, fetchImpl: upstream.fetchImpl })], rate);
    return { service, upstream };
  }

  it('下单：Checkout Session 表单正确（分单位/商户单号/密钥），订单 provider=stripe', async () => {
    const account = await newUser();
    const { service, upstream } = stripeService('2');
    const order = await service.createTopupOrder(ctx, account.id, { amount: '10.10', provider: 'stripe' });
    const sessionId = upstream.calls[0]!.sessionId;
    expect(order.payUrl).toBe(`https://checkout.stripe.com/c/pay/${sessionId}`);
    expectAmountEq(order.creditAmount, '20.2');
    expect(upstream.calls.length).toBe(1);
    expect(upstream.calls[0]!.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(upstream.calls[0]!.auth).toBe(`Bearer ${STRIPE.secretKey}`);
    expect(upstream.calls[0]!.body.get('line_items[0][price_data][unit_amount]')).toBe('1010');
    expect(upstream.calls[0]!.body.get('client_reference_id')).toBe(order.orderId);
    expect(upstream.calls[0]!.body.get('success_url')).toBe(STRIPE.successUrl);
    const row = await repos.paymentOrder.findById(
      { db, requestId: 't', actor: { kind: 'system' }, traceParent: null },
      order.orderId,
    );
    expect(row!.provider).toBe('stripe');
    expect(row!.providerOrderId).toBe(sessionId);
    expect(row!.status).toBe(0);
  });

  it('webhook happy path：验签→金额核对→入账（分→元重建无浮点尾差）', async () => {
    const account = await newUser();
    const { service, upstream } = stripeService();
    const order = await service.createTopupOrder(ctx, account.id, { amount: '10.10', provider: 'stripe' });
    const answer = await service.handleNotify(
      ctx,
      'stripe',
      signedWebhook({ sessionId: upstream.calls[0]!.sessionId, orderId: order.orderId, amountCents: 1010 }),
    );
    expect(answer).toBe('success');
    expectAmountEq(await balanceOf(account.id), '10.10');
    const row = await repos.paymentOrder.findById(
      { db, requestId: 't', actor: { kind: 'system' }, traceParent: null },
      order.orderId,
    );
    expect(row!.status).toBe(2);
  });

  it('重复 webhook：幂等 success，余额只入一次', async () => {
    const account = await newUser();
    const { service, upstream } = stripeService();
    const order = await service.createTopupOrder(ctx, account.id, { amount: '8', provider: 'stripe' });
    const sessionId = upstream.calls[0]!.sessionId;
    const first = await service.handleNotify(ctx, 'stripe', signedWebhook({ sessionId, orderId: order.orderId, amountCents: 800 }));
    expect(first).toBe('success');
    for (let i = 0; i < 2; i++) {
      expect(
        await service.handleNotify(ctx, 'stripe', signedWebhook({ sessionId, orderId: order.orderId, amountCents: 800 })),
      ).toBe('success');
    }
    expectAmountEq(await balanceOf(account.id), '8');
  });

  it('坏签名（错密钥/篡改载荷/过期时间戳）→ fail，零入账', async () => {
    const account = await newUser();
    const { service, upstream } = stripeService();
    const order = await service.createTopupOrder(ctx, account.id, { amount: '5', provider: 'stripe' });
    const sessionId = upstream.calls[0]!.sessionId;

    const wrongSecret = signedWebhook({ sessionId, orderId: order.orderId, amountCents: 500, secret: 'whsec_other' });
    expect(await service.handleNotify(ctx, 'stripe', wrongSecret)).toBe('fail');

    const stale = signedWebhook({ sessionId, orderId: order.orderId, amountCents: 500, timestampOffsetS: -3600 });
    expect(await service.handleNotify(ctx, 'stripe', stale)).toBe('fail');

    const tampered = signedWebhook({ sessionId, orderId: order.orderId, amountCents: 500 });
    tampered.payload = tampered.payload.replace('500', '999');
    expect(await service.handleNotify(ctx, 'stripe', tampered)).toBe('fail');

    expectAmountEq(await balanceOf(account.id), '0');
    const row = await repos.paymentOrder.findById(
      { db, requestId: 't', actor: { kind: 'system' }, traceParent: null },
      order.orderId,
    );
    expect(row!.status).toBe(0);
  });

  it('金额篡改（签名合法但 amount_total 少于订单）→ fail，零入账', async () => {
    const account = await newUser();
    const { service, upstream } = stripeService();
    const order = await service.createTopupOrder(ctx, account.id, { amount: '100', provider: 'stripe' });
    // 真密钥签一份 amount_total=1 分的事件——验签通过，金额闸拒绝
    expect(
      await service.handleNotify(
        ctx,
        'stripe',
        signedWebhook({ sessionId: upstream.calls[0]!.sessionId, orderId: order.orderId, amountCents: 1 }),
      ),
    ).toBe('fail');
    expectAmountEq(await balanceOf(account.id), '0');
  });

  it('未知 session / 未配置渠道的回调 → fail', async () => {
    const { service } = stripeService();
    expect(
      await service.handleNotify(
        ctx,
        'stripe',
        signedWebhook({ sessionId: 'cs_unknown', orderId: '00000000-0000-0000-0000-000000000000', amountCents: 500 }),
      ),
    ).toBe('fail');
    const epayOnly = buildService();
    expect(
      await epayOnly.handleNotify(ctx, 'stripe', signedWebhook({ orderId: 'x', amountCents: 500 })),
    ).toBe('fail');
  });
});

describe('防御路径（注入仓储桩——回调乱序跃迁与机会式关单容错）', () => {
  /** 真仓储 + 指定方法覆盖（原型委托：其余方法走真 PG，覆盖仅遮蔽指定项） */
  function stubbedRepos(overrides: Partial<typeof repos.paymentOrder>) {
    const paymentOrder = Object.create(repos.paymentOrder) as typeof repos.paymentOrder;
    Object.assign(paymentOrder, overrides);
    return { ...repos, paymentOrder };
  }

  it('markPaid 输掉并发且订单消失（被删）→ 409 被吞为 fail，零入账', async () => {
    const account = await newUser();
    const service = createPaymentsService({
      db,
      wallet,
      providers: [createEpayProvider(EPAY)],
      currency: 'CNY',
      topupMin: '1',
      topupMax: '10000',
      exchangeRate: '1',
      orderTtlMs: 1_800_000,
      repos: stubbedRepos({
        markPaid: async () => null,
        findById: async () => null,
      }),
    });
    const order = await service.createTopupOrder(ctx, account.id, { amount: '5' });
    expect(await service.handleNotify(ctx, 'epay', signedNotify(order.orderId, '5'))).toBe('fail');
    expectAmountEq(await balanceOf(account.id), '0');
  });

  it('markPaid 输掉并发但单据已 paid（并发赢家置 1）→ 继续收尾入账（success）', async () => {
    const account = await newUser();
    const base = buildService();
    const order = await base.createTopupOrder(ctx, account.id, { amount: '5' });
    // 并发赢家已把单据置 paid(1)：本路 markPaid 恒输 → 重读为 1 → 直接收尾
    await db
      .update(paymentOrders)
      .set({ status: 1, paidAt: new Date() })
      .where(eq(paymentOrders.id, order.orderId));
    const service = createPaymentsService({
      db,
      wallet,
      providers: [createEpayProvider(EPAY)],
      currency: 'CNY',
      topupMin: '1',
      topupMax: '10000',
      exchangeRate: '1',
      orderTtlMs: 1_800_000,
      repos: stubbedRepos({ markPaid: async () => null }),
    });
    expect(await service.handleNotify(ctx, 'epay', signedNotify(order.orderId, '5'))).toBe('success');
    expectAmountEq(await balanceOf(account.id), '5');
  });

  it('markPaid 输掉并发且重读为非法状态 → fail', async () => {
    const account = await newUser();
    const base = buildService();
    const order = await base.createTopupOrder(ctx, account.id, { amount: '5' });
    const service = createPaymentsService({
      db,
      wallet,
      providers: [createEpayProvider(EPAY)],
      currency: 'CNY',
      topupMin: '1',
      topupMax: '10000',
      exchangeRate: '1',
      orderTtlMs: 1_800_000,
      repos: stubbedRepos({
        markPaid: async () => null,
        findById: async () =>
          ({ ...order, status: 4 }) as unknown as Awaited<ReturnType<typeof repos.paymentOrder.findById>>,
      }),
    });
    expect(await service.handleNotify(ctx, 'epay', signedNotify(order.orderId, '5'))).toBe('fail');
    expectAmountEq(await balanceOf(account.id), '0');
  });

  it('机会式关单失败不阻断列表（吞错返回真实行）', async () => {
    const account = await newUser();
    const base = buildService();
    const mine = await base.createTopupOrder(ctx, account.id, { amount: '5' });
    const service = createPaymentsService({
      db,
      wallet,
      providers: [createEpayProvider(EPAY)],
      currency: 'CNY',
      topupMin: '1',
      topupMax: '10000',
      exchangeRate: '1',
      orderTtlMs: 1_800_000,
      repos: stubbedRepos({
        expireOverdue: async () => {
          throw new Error('db glitch');
        },
      }),
    });
    const rows = await service.listOrders(ctx, account.id, { page: 1, limit: 10 });
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(mine.orderId);
  });
});

describe('订单列表与关单', () => {
  it('列表只含本人订单；超时未支付机会式置 expired', async () => {
    const account = await newUser();
    const other = await newUser();
    const service = buildService();
    const mine = await service.createTopupOrder(ctx, account.id, { amount: '5' });
    await service.createTopupOrder(ctx, other.id, { amount: '5' });

    const ttlShort = createPaymentsService({
      db,
      wallet,
      providers: [createEpayProvider(EPAY)],
      currency: 'CNY',
      topupMin: '1',
      topupMax: '10000',
      exchangeRate: '1',
      orderTtlMs: 1, // 下一秒即超时
    });
    await new Promise((r) => setTimeout(r, 20));
    const rows = await ttlShort.listOrders(ctx, account.id, { page: 1, limit: 10 });
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(mine.orderId);
    expect(rows[0]!.status).toBe(4);
  });
});

describe('充值支付 · 过期单复活（已付款不搁浅）', () => {
  it('订单被关单(status=4)后合法回调到达 → 复活入账（渠道确实收到了钱）', async () => {
    const service = buildService();
    const account = await newUser();
    const userId = account.id;
    const order = await service.createTopupOrder(ctx, userId, { amount: '10' });
    // 模拟：列表机会式关单把支付中的订单置 4（用户扫码后 31 分钟才付款）
    await db
      .update(paymentOrders)
      .set({ status: 4, failureReason: 'expired' })
      .where(eq(paymentOrders.id, order.orderId));

    const answer = await service.handleNotify(ctx, 'epay', signedNotify(order.orderId, '10'));
    expect(answer).toBe('success'); // 修复前：markPaid CAS 失败 + status=4 → 409 → 'fail' 永久拒绝

    const [row] = await db
      .select({ status: paymentOrders.status })
      .from(paymentOrders)
      .where(eq(paymentOrders.id, order.orderId));
    expect(row!.status).toBe(2); // paid → credited 收尾完成
    expectAmountEq(await balanceOf(userId), '10');
  });

  it('金额不一致的回调即使订单过期也不复活（少付多得防线不因复活路径松动）', async () => {
    const service = buildService();
    const account = await newUser();
    const userId = account.id;
    const order = await service.createTopupOrder(ctx, userId, { amount: '10' });
    await db
      .update(paymentOrders)
      .set({ status: 4, failureReason: 'expired' })
      .where(eq(paymentOrders.id, order.orderId));

    const answer = await service.handleNotify(ctx, 'epay', signedNotify(order.orderId, '5'));
    expect(answer).toBe('fail');
    const [row] = await db
      .select({ status: paymentOrders.status })
      .from(paymentOrders)
      .where(eq(paymentOrders.id, order.orderId));
    expect(row!.status).toBe(4); // 未被复活
    expectAmountEq(await balanceOf(userId), '0');
  });

  it('超过两位小数的面额直接 400（Stripe 分单位位截断会造成永久对不上的搁浅单）', async () => {
    const service = buildService([createStripeProvider({ ...STRIPE, fetchImpl: stripeUpstream().fetchImpl })]);
    const account = await newUser();
    await expect(
      service.createTopupOrder(ctx, account.id, { amount: '10.999', provider: 'stripe' }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
