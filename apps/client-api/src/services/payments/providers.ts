import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

/**
 * PaymentProvider 抽象（在线支付单一契约）：
 *   createOrder —— 下单（返回渠道跳转/收银台信息）
 *   verifyCallback —— 验签回调载荷（渠道签名校验，恒定时间比较）
 * 订单状态机与幂等入账在 ledger（单一真相）；本层只做渠道协议。
 *
 * 已注册：epay（易支付，MD5 签名）、stripe（Checkout Session + webhook HMAC）。
 */

export interface CreateOrderInput {
  /** payment_orders.id（uuid）——同时作为渠道侧商户订单号 */
  orderId: string;
  /** 实付金额（元） */
  amount: string;
  subject: string;
}

export interface CreateOrderResult {
  /** 渠道侧订单号（易支付 trade_no 域我们自增 store 订单号；stripe = session id） */
  providerOrderId: string;
  /** 客户端支付引导（跳转 URL / 收银台） */
  payUrl: string;
}

export interface CallbackInput {
  /** 原始查询串/头/体（验签材料） */
  raw: Record<string, string>;
}

export interface CallbackResult {
  ok: boolean;
  providerOrderId: string;
  paidAmount: string;
}

export interface PaymentProvider {
  readonly name: 'epay' | 'stripe';
  createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;
  verifyCallback(input: CallbackInput): CallbackResult | null;
}

// ─────────────────────────── 易支付（EPay 通用协议） ───────────────────────────

export interface EpayConfig {
  /** 商户 ID（pid） */
  pid: string;
  /** 商户密钥（MD5 签名） */
  key: string;
  /** 网关提交地址，如 https://pay.example.com/submit.php */
  gatewayUrl: string;
  /** 本站回调地址（notify_url） */
  notifyUrl: string;
  /** 支付完成跳转地址（return_url） */
  returnUrl: string;
}

/** 易支付参数签名（键序 MD5，剔除 sign/sign_type/空值——通用协议约定） */
export function epaySign(params: Record<string, string>, key: string): string {
  const sorted = Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'sign_type' && params[k] !== '' && params[k] !== undefined)
    .toSorted();
  const query = sorted.map((k) => `${k}=${params[k]}`).join('&');
  return createHash('md5').update(`${query}${key}`).digest('hex');
}

export function createEpayProvider(config: EpayConfig): PaymentProvider {
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
      return {
        // 易支付无预下单 API：商户订单号即 providerOrderId（回调 trade_no 为渠道流水，忽略）
        providerOrderId: input.orderId,
        payUrl: `${config.gatewayUrl}?${query}`,
      };
    },
    verifyCallback(input) {
      const raw = input.raw;
      if (raw.out_trade_no === undefined || raw.trade_status === undefined) return null;
      if (raw.trade_status !== 'TRADE_SUCCESS') return null;
      const expected = epaySign(raw, config.key);
      const provided = raw.sign ?? '';
      const a = Buffer.from(expected, 'utf8');
      const b = Buffer.from(provided, 'utf8');
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
      return { ok: true, providerOrderId: raw.out_trade_no!, paidAmount: raw.money ?? '0' };
    },
  };
}

// ─────────────────────────── Stripe ───────────────────────────

export interface StripeConfig {
  secretKey: string;
  /** webhook 端点签名密钥（whsec_...） */
  webhookSecret: string;
  /** 本站回调地址 */
  webhookUrl: string;
  successUrl: string;
  cancelUrl: string;
  fetchImpl?: typeof fetch;
}

export function createStripeProvider(config: StripeConfig): PaymentProvider {
  const doFetch = config.fetchImpl ?? fetch;
  return {
    name: 'stripe',
    async createOrder(input) {
      // Checkout Session 创建（form-encoded，无 SDK 依赖）
      const body = new URLSearchParams({
        mode: 'payment',
        'line_items[0][price_data][currency]': 'cny',
        'line_items[0][price_data][unit_amount]': String(Math.round(Number(input.amount) * 100)),
        'line_items[0][price_data][product_data][name]': input.subject,
        'line_items[0][quantity]': '1',
        client_reference_id: input.orderId,
        success_url: config.successUrl,
        cancel_url: config.cancelUrl,
        'metadata[order_id]': input.orderId,
      });
      const res = await doFetch('https://api.stripe.com/v1/checkout/sessions', {
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
    verifyCallback(input) {
      // 签名头：Stripe-Signature: t=timestamp,v1=hmac_sha256(`${t}.${payload}`, secret)
      const signature = input.raw['stripe-signature'] ?? '';
      const payload = input.raw.payload ?? '';
      const parts = Object.fromEntries(
        signature.split(',').map((kv) => {
          const [k, v] = kv.split('=');
          return [k?.trim() ?? '', v?.trim() ?? ''];
        }),
      ) as { t?: string; v1?: string };
      if (!parts.t || !parts.v1) return null;
      const expected = createHmac('sha256', config.webhookSecret)
        .update(`${parts.t}.${payload}`)
        .digest('hex');
      const a = Buffer.from(expected, 'utf8');
      const b = Buffer.from(parts.v1, 'utf8');
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
      // 时间窗防重放（5 分钟）
      if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return null;
      let event: {
        type?: string;
        data?: { object?: { id?: string; client_reference_id?: string; amount_total?: number; metadata?: Record<string, string> } };
      };
      try {
        event = JSON.parse(payload);
      } catch {
        return null;
      }
      if (event.type !== 'checkout.session.completed') return null;
      const obj = event.data?.object ?? {};
      const orderId = obj.client_reference_id ?? obj.metadata?.order_id;
      if (!orderId) return null;
      return {
        ok: true,
        providerOrderId: obj.id ?? orderId,
        paidAmount: String((obj.amount_total ?? 0) / 100),
      };
    },
  };
}

export type { CreateOrderInput as PaymentCreateOrderInput };
