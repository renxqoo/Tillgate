/**
 * 支付渠道适配（epay / stripe）：PaymentProviderPort 的两个实现。
 * 协议纯规则在 domain/payment/{epay,stripe}；此处只做 IO 组装。
 */
import { epaySign, epayVerify, parseEpayNotify } from '../../domain/payment/epay.js';
import {
  parseStripeEvent,
  stripeCentsFromAmount,
  verifyStripeSignature,
} from '../../domain/payment/stripe.js';
import type { PaymentProviderPort } from '../../ports/payment-ports.js';

/** 易支付渠道适配（签名纯规则在 domain/payment/epay） */
export function createEpayProvider(config: {
  pid: string;
  key: string;
  gatewayUrl: string;
  notifyUrl: string;
  returnUrl: string;
  clock?: () => number;
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
        timestamp: String(Math.floor((config.clock ?? Date.now)() / 1000)),
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
      if (query.pid !== config.pid) return null;
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

/** Stripe 渠道适配（Checkout Session 创建 + webhook 验签规则在 domain/payment/stripe） */
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
