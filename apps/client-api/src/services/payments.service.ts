/**
 * 充值支付服务：下单（面额闸 → 渠道签名 → 订单落库）+ 回调入账（验签 → 金额核对
 * → 单事务 markPaid→credit→markCredited）+ 用户订单列表（机会式关单）。
 *
 * 资损不变量：
 *   - creditAmount 创建时定死（amount × 汇率），回调只认订单不重算
 *   - 验签证来源、金额核对防篡改（签名合法 ≠ 金额合法——两道独立闸）
 *   - paid→credited 与入账同一事务：崩溃时订单停留 created/paid，渠道重发回调重放
 *   - 入账幂等锚 refType='topup' + refId=orderId：重复回调结构性只入一次
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '@ai-gateway/repository';
import {
  createRepositories,
  type Repositories,
  type PaymentOrderRow,
} from '@ai-gateway/repository';
import type { RunContext, WalletApi } from '@ai-gateway/service';
import type { FixedWindowCounter } from './rate-counter.js';
import { AppError } from '../http/error-map.js';
import {
  assertTopupWithinLimit,
  amountsMatch,
  computeCreditAmount,
} from '../domain/topup.js';
import { epaySign, epayVerify, parseEpayNotify } from '../domain/epay.js';
import {
  parseStripeEvent,
  stripeCentsFromAmount,
  verifyStripeSignature,
} from '../domain/stripe.js';

/** 支付渠道端口（app 内协议适配；epay/stripe 按同口接入） */
export interface PaymentProviderPort {
  readonly name: 'epay' | 'stripe';
  /** 创建渠道支付（返回支付跳转 URL；providerOrderId 商户侧单号） */
  createOrder(input: {
    orderId: string;
    amount: string;
    subject: string;
  }): Promise<{ providerOrderId: string; payUrl: string }>;
  /**
   * 回调验签+归一：返回 null = 拒收（验签失败/状态非成功/缺字段）；
   * 金额核对在 service（需要订单真相）。raw 为验签材料包——
   * epay=回调 query/form 键值，stripe={payload: 原始事件体, 'stripe-signature': 头}
   */
  parseNotify(raw: Record<string, string>): {
    providerOrderId: string;
    /** 商户订单号回退锚（Stripe client_reference_id——attach 失败/竞态时按它定位订单） */
    merchantOrderId?: string;
    paidAmount: string;
  } | null;
}

/** 易支付渠道适配（签名纯规则在 domain/epay） */
export function createEpayProvider(config: {
  pid: string;
  key: string;
  gatewayUrl: string;
  notifyUrl: string;
  returnUrl: string;
}): PaymentProviderPort {
  return {
    name: 'epay',
    async createOrder(input) {
      const params: Record<string, string> = {
        pid: config.pid,
        type: 'alipay',
        out_trade_no: input.orderId,
        notify_url: config.notifyUrl,
        return_url: config.returnUrl,
        name: input.subject,
        money: input.amount,
        timestamp: String(Math.floor(Date.now() / 1000)),
      };
      params.sign = epaySign(params, config.key);
      params.sign_type = 'MD5';
      const query = Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
      // 易支付无预下单 API：商户订单号即 providerOrderId（渠道回调 trade_no 忽略）
      return { providerOrderId: input.orderId, payUrl: `${config.gatewayUrl}?${query}` };
    },
    parseNotify(query) {
      if (!epayVerify(query, config.key)) return null;
      const payload = parseEpayNotify(query);
      if (!payload || payload.tradeStatus !== 'TRADE_SUCCESS') return null;
      return { providerOrderId: payload.providerOrderId, paidAmount: payload.amount };
    },
  };
}

export interface StripeProviderConfig {
  secretKey: string;
  /** webhook 端点签名密钥（whsec_...） */
  webhookSecret: string;
  successUrl: string;
  cancelUrl: string;
  /** API 基地址（默认官方；测试注入 mock 上游） */
  apiBase?: string;
  fetchImpl?: typeof fetch;
  clock?: () => number;
}

/** Stripe 渠道适配（Checkout Session 创建 + webhook 验签规则在 domain/stripe） */
export function createStripeProvider(config: StripeProviderConfig): PaymentProviderPort {
  const doFetch = config.fetchImpl ?? fetch;
  const nowMs = config.clock ?? (() => Date.now());
  const apiBase = config.apiBase ?? 'https://api.stripe.com';
  return {
    name: 'stripe',
    async createOrder(input) {
      // Checkout Session 创建（form-encoded，无 SDK 依赖）
      const body = new URLSearchParams({
        mode: 'payment',
        'line_items[0][price_data][currency]': 'cny',
        'line_items[0][price_data][unit_amount]': stripeCentsFromAmount(input.amount),
        'line_items[0][price_data][product_data][name]': input.subject,
        'line_items[0][quantity]': '1',
        client_reference_id: input.orderId,
        success_url: config.successUrl,
        cancel_url: config.cancelUrl,
        'metadata[order_id]': input.orderId,
      });
      const res = await doFetch(`${apiBase}/v1/checkout/sessions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });
      if (!res.ok) {
        throw new Error(`stripe create session failed: ${res.status}`);
      }
      const session = (await res.json()) as { id: string; url: string };
      return { providerOrderId: session.id, payUrl: session.url };
    },
    parseNotify(raw) {
      const payload = raw.payload ?? '';
      const header = raw['stripe-signature'] ?? '';
      if (!verifyStripeSignature(header, payload, config.webhookSecret, nowMs())) return null;
      const event = parseStripeEvent(payload);
      if (!event) return null;
      return {
        providerOrderId: event.sessionId,
        merchantOrderId: event.orderId,
        paidAmount: event.paidAmount,
      };
    },
  };
}

export interface PaymentsServiceDeps {
  db: Db;
  wallet: WalletApi;
  repos?: Repositories;
  /** 已配置的支付渠道（空数组 = 在线充值关闭；可多渠道并存） */
  providers: readonly PaymentProviderPort[];
  currency: string;
  topupMin: string;
  topupMax: string;
  exchangeRate: string;
  orderTtlMs: number;
  /** 下单频率闸（per-user 固定窗口；缺省 10 次/分钟）。每次下单都是真实渠道会话
   *  （Stripe API 配额是全平台共享）+ 订单行落库——无闸即可被脚本刷爆 */
  orderLimiter?: FixedWindowCounter;
  perMinuteOrderLimit?: number;
  clock?: () => Date;
}

export interface PaymentsService {
  createTopupOrder(
    ctx: RunContext,
    userId: number,
    input: { amount: string; provider?: 'epay' | 'stripe' },
  ): Promise<{ orderId: string; payUrl: string; creditAmount: string }>;
  /** 渠道回调（无会话——验签是唯一信任源）。返回给渠道的应答体字符串 */
  handleNotify(
    ctx: RunContext,
    provider: 'epay' | 'stripe',
    raw: Record<string, string>,
  ): Promise<string>;
  /** 订单详情（v1 GET /api/payments/:id 对位——支付后轮询） */
  orderDetail(ctx: RunContext, userId: number, orderId: string): Promise<PaymentOrderRow>;
  listOrders(
    ctx: RunContext,
    userId: number,
    input: { page: number; limit: number },
  ): Promise<PaymentOrderRow[]>;
  /** 已启用渠道（前端充值入口渲染） */
  channels(): Array<{ id: 'epay' | 'stripe'; label: string }>;
}

const PROVIDER_LABELS: Record<'epay' | 'stripe', string> = {
  epay: '在线支付（支付宝/微信）',
  stripe: 'Stripe（国际卡）',
};

const asUser = (ctx: RunContext, userId: number): RunContext => ({
  ...ctx,
  actor: { kind: 'user', id: userId },
});

export function createPaymentsService(deps: PaymentsServiceDeps): PaymentsService {
  const { db, wallet } = deps;
  const repos = deps.repos ?? createRepositories();
  const clock = deps.clock ?? (() => new Date());
  const byName = new Map(deps.providers.map((p) => [p.name, p]));

  /** 渠道解析：显式指定须命中；未指定时唯一渠道直通，多渠道须显式选择 */
  const resolveProvider = (requested?: 'epay' | 'stripe'): PaymentProviderPort => {
    if (requested) {
      const found = byName.get(requested);
      if (!found) throw new AppError(503, 'payment_unavailable', '该支付渠道未启用');
      return found;
    }
    if (deps.providers.length === 1) return deps.providers[0]!;
    throw new AppError(503, 'payment_unavailable', '该支付渠道未启用');
  };

  return {
    async createTopupOrder(ctx, userId, input) {
      if (deps.orderLimiter) {
        let n: number;
        try {
          n = await deps.orderLimiter.hit(`topup-order:${userId}`, 60);
        } catch {
          throw new AppError(503, 'rate_counter_unavailable', '频率计数器不可用，请稍后再试');
        }
        if (n > (deps.perMinuteOrderLimit ?? 10)) {
          throw new AppError(429, 'topup_rate_limited', '下单过于频繁，请稍后再试');
        }
      }
      assertTopupWithinLimit(input.amount, deps.topupMin, deps.topupMax);
      const provider = resolveProvider(input.provider);
      const creditAmount = computeCreditAmount(input.amount, deps.exchangeRate);
      const orderId = randomUUID();
      // 先落 DB 行再调渠道（v1 对位）：渠道成功与落库之间的崩溃会留下
      // 「可支付但无 DB 行」的渠道会话 = 无法对账的资金黑洞；反过来渠道失败
      // 只是本地一行 status=0 订单（由 TTL 关单自然回收）
      await db.transaction(async (tx) =>
        repos.paymentOrder.insertOrder(
          { db: tx, ...asUser(ctx, userId) },
          {
            id: orderId,
            provider: provider.name,
            providerOrderId: orderId, // 占位：epay 即终值；Stripe 建会话后回填
            userId,
            amount: input.amount,
            currency: deps.currency,
            creditAmount,
          },
        ),
      );
      let channel: { providerOrderId: string; payUrl: string };
      try {
        channel = await provider.createOrder({
          orderId,
          amount: input.amount,
          subject: '余额充值',
        });
      } catch (error) {
        // 渠道下单失败：关单留痕（v1 语义）——渠道侧确定性失败即刻可见；
        // 用户拿到明确 502 而非裸 500
        console.error(`[client-api] payment channel create failed order=${orderId}:`, error);
        await db.$client
          .query("update payment_orders set status = 4, failure_reason = 'channel_create_failed', updated_at = clock_timestamp() where id = $1 and status = 0", [orderId])
          .catch(() => undefined);
        throw new AppError(502, 'payment_channel_unavailable', '支付渠道暂时不可用，请稍后再试');
      }
      // 渠道会话已建立：回填真实渠道单号（Stripe session id；epay 与占位相同无操作）。
      // 回填是回调定位锚——失败必须大声（静默吞 = webhook 永远找不到订单 = 已付款搁浅）
      if (channel.providerOrderId !== orderId) {
        await repos.paymentOrder.attachProviderOrderId(
          { db, ...asUser(ctx, userId) },
          { orderId, providerOrderId: channel.providerOrderId },
        ).catch((error) => {
          console.error(`[client-api] attach provider order id failed order=${orderId} channel=${channel.providerOrderId}:`, error);
        });
      }
      return { orderId, payUrl: channel.payUrl, creditAmount };
    },

    async handleNotify(ctx, providerName, raw) {
      const provider = byName.get(providerName);
      if (!provider) return 'fail';
      const parsed = provider.parseNotify(raw);
      if (!parsed) return 'fail';

      const sys: RunContext = { ...ctx, actor: { kind: 'system' } };
      let order = await repos.paymentOrder.findByProviderOrderId(
        { db, ...sys },
        { provider: providerName, providerOrderId: parsed.providerOrderId },
      );
      if (!order && parsed.merchantOrderId) {
        // 回退锚：渠道会话号回填失败/竞态未达时按商户订单号定位（v1 同语义——
        // 没有它 Stripe webhook 在 attach 缺席时永远找不到订单 = 已付款搁浅）
        const byMerchant = await repos.paymentOrder.findById({ db, ...sys }, parsed.merchantOrderId);
        if (byMerchant?.provider === providerName) order = byMerchant;
      }
      if (!order) return 'fail';
      // 金额核对：签名只证来源，金额才防「少付多得」（按订单实付比对，全精度）
      if (!amountsMatch(parsed.paidAmount, order.amount)) {
        console.error('[client-api] payment notify amount mismatch:', order.id);
        return 'fail';
      }
      // 已入账：重复回调幂等成功应答（渠道停止重发）
      if (order.status === 2) return 'success';

      try {
        await db.transaction(async (tx) => {
          const c = { db: tx, ...sys };
          const paid = await repos.paymentOrder.markPaid(c, { orderId: order.id, paidAt: clock() });
          if (!paid) {
            // 并发回调/乱序跃迁：重读定夺（credited 幂等成功；paid 遗留单继续收尾入账）
            let fresh = await repos.paymentOrder.findById(c, order.id);
            if (fresh == null) throw new AppError(409, 'order_state_conflict', '订单不存在');
            if (fresh.status === 2) return;
            if (fresh.status === 4) {
              // 过期单 + 已验签 + 金额一致 = 用户已付款（过期只是关单标记，非资金事实）——
              // 复活收尾入账；不复活即「扣了钱不记账」的搁浅单（无自动对账路径）
              const revived = await repos.paymentOrder.reviveExpiredAsPaid(c, {
                orderId: order.id,
                paidAt: clock(),
              });
              if (revived) {
                fresh = await repos.paymentOrder.findById(c, order.id);
              }
            }
            if (fresh == null || fresh.status !== 1) {
              throw new AppError(409, 'order_state_conflict', '订单状态跃迁冲突');
            }
          }
          await wallet.credit(sys, {
            userId: order.userId,
            amount: order.creditAmount,
            refType: 'topup',
            refId: order.id,
            memo: `在线充值入账（${order.provider} ${order.amount} ${order.currency}）`,
            tx,
          });
          const done = await repos.paymentOrder.markCredited(c, {
            orderId: order.id,
            creditedAt: clock(),
          });
          if (!done) throw new AppError(409, 'order_state_conflict', '订单状态跃迁冲突');
        });
        return 'success';
      } catch (e) {
        console.error('[client-api] payment credit failed (order stays retryable):', e);
        return 'fail';
      }
    },

    async orderDetail(ctx, userId, orderId) {
      const row = await repos.paymentOrder.findByUserAndId(
        { db, ...asUser(ctx, userId) },
        { userId, orderId },
      );
      if (!row) throw new AppError(404, 'order_not_found', '订单不存在');
      return row;
    },

    async listOrders(ctx, userId, input) {
      const runCtx = asUser(ctx, userId);
      // 机会式关单：未支付且超 TTL 的订单置 expired（best-effort，失败不阻断列表）。
      // 只关自己的单——全局关单会把他人支付中的订单误关，制造「已付款被拒收」搁浅单
      try {
        await db.transaction(async (tx) =>
          repos.paymentOrder.expireOverdue(
            { db: tx, ...runCtx },
            { userId, createdBefore: new Date(clock().getTime() - deps.orderTtlMs) },
          ),
        );
      } catch {
        /* 机会式 */
      }
      return repos.paymentOrder.listByUser({ db, ...runCtx }, {
        userId,
        limit: input.limit,
        offset: (input.page - 1) * input.limit,
      });
    },

    channels() {
      return deps.providers.map((p) => ({ id: p.name, label: PROVIDER_LABELS[p.name] }));
    },
  };
}
