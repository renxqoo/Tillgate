/**
 * 支付渠道适配（epay / stripe）：PaymentProviderPort 的两个实现。
 * 协议纯规则在 domain/payment/{epay,stripe}；此处只做 IO 组装。
 * 币种与支付类型是部署配置事实（与装配的 PaymentsDeps.currency 同源注入），
 * 不在适配器写死——币种单真相（铁律 3）。
 */
import {
  EPAY_PAY_TYPES,
  epaySign,
  epayVerify,
  parseEpayNotify,
} from '../../domain/payment/epay.js';
import {
  parseStripeEvent,
  stripeMinorUnitsFromAmount,
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
  /** 支付类型（必填配置；从 EPAY_PAY_TYPES 词表校验——不写死 'alipay'） */
  payType: (typeof EPAY_PAY_TYPES)[number];
  /** 验签密钥序列（先新后旧，旧值仅双读窗内——DESIGN integration-settings §5 D6；缺省 [key]） */
  verifyKeys?: readonly string[];
  clock?: () => number;
}): PaymentProviderPort {
  if (!EPAY_PAY_TYPES.includes(config.payType)) {
    throw new Error(
      `epay pay type not supported: ${config.payType} (allowed: ${EPAY_PAY_TYPES.join('/')})`,
    );
  }
  if (config.verifyKeys != null && config.verifyKeys.length === 0) {
    // 空验签序列 = 静默关死回调面——fail-loud（review 修复 C-1）
    throw new Error('epay verifyKeys must not be empty');
  }
  return {
    name: 'epay',
    accepting: () => true,
    async createOrder(input) {
      const query = epaySignedQuery(config, input);
      // 易支付无预下单 API：商户订单号即 providerOrderId（渠道回调 trade_no 忽略）
      return { providerOrderId: input.orderId, payUrl: `${config.gatewayUrl}?${query}` };
    },
    parseNotify(query) {
      if (!verifyEpaySigned(query, config)) return null;
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
  /** webhook 验签密钥序列（先新后旧，旧值仅双读窗内；缺省 [webhookSecret]） */
  webhookSecrets?: readonly string[];
  successUrl: string;
  cancelUrl: string;
  /** 计费币种（必填注入：下单 line_items 与回调币种闸同源——不写死 'cny'） */
  currency: string;
  /** API 基地址（默认官方；测试注入 mock 上游） */
  apiBase?: string;
  fetchImpl?: typeof fetch;
  clock?: () => number;
}

/** Stripe 渠道适配（Checkout Session 创建 + webhook 验签规则在 domain/payment/stripe） */
export function createStripeProvider(config: StripeProviderConfig): PaymentProviderPort {
  // 空验签序列 = 静默关死 webhook 面（review 修复 C-1）——fail-loud 拒绝构造
  if (config.webhookSecrets != null && config.webhookSecrets.length === 0) {
    throw new Error('stripe webhookSecrets must not be empty');
  }
  const doFetch = config.fetchImpl ?? fetch;
  const nowMs = config.clock ?? (() => Date.now());
  const apiBase = config.apiBase ?? 'https://api.stripe.com';
  return {
    name: 'stripe',
    accepting: () => true,
    async createOrder(input) {
      // Checkout Session 创建（form-encoded，无 SDK 依赖）
      const body = new URLSearchParams({
        mode: 'payment',
        'line_items[0][price_data][currency]': config.currency.toLowerCase(),
        'line_items[0][price_data][unit_amount]': stripeMinorUnitsFromAmount(
          input.amount,
          config.currency,
        ),
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
      return stripeParseNotify(config, raw, nowMs);
    },
  };
}

/** webhook 验签归一（独立职责）：密钥序列先新后旧（双读窗），事件币种闸在 domain */
function stripeParseNotify(
  config: StripeProviderConfig,
  raw: Record<string, string>,
  nowMs: () => number,
): { providerOrderId: string; merchantOrderId?: string; paidAmount: string } | null {
  const payload = raw.payload ?? '';
  const header = raw['stripe-signature'] ?? '';
  const webhookSecrets = config.webhookSecrets ?? [config.webhookSecret];
  const verified = webhookSecrets.some((secret) =>
    verifyStripeSignature(header, payload, secret, nowMs()),
  );
  if (!verified) return null;
  const event = parseStripeEvent(payload, config.currency);
  if (!event) return null;
  return {
    providerOrderId: event.sessionId,
    merchantOrderId: event.orderId,
    paidAmount: event.paidAmount,
  };
}

/** epay 回调验签（密钥序列先新后旧——双读窗；空序列已构造期拒绝） */
function verifyEpaySigned(
  query: Record<string, string>,
  config: { key: string; verifyKeys?: readonly string[] },
): boolean {
  const verifyKeys = config.verifyKeys ?? [config.key];
  return verifyKeys.some((secret) => epayVerify(query, secret));
}

/** epay 下单签名参数串（键序 MD5——domain 纯规则；下单签名恒用当前 key） */
function epaySignedQuery(
  config: {
    pid: string;
    key: string;
    payType: string;
    notifyUrl: string;
    returnUrl: string;
    clock?: () => number;
  },
  input: { orderId: string; amount: string; subject: string },
): string {
  const params: Record<string, string> = {
    pid: config.pid,
    type: config.payType,
    out_trade_no: input.orderId,
    notify_url: config.notifyUrl,
    return_url: config.returnUrl,
    name: input.subject,
    money: input.amount,
    timestamp: String(Math.floor((config.clock ?? Date.now)() / 1000)),
  };
  params.sign = epaySign(params, config.key);
  params.sign_type = 'MD5';
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}
