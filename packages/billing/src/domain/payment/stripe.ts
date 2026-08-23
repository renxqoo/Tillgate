/**
 * Stripe 协议纯规则（无 IO）：webhook 验签 / 重放窗 / 事件归一 / 金额分转换。
 * 签名方案（Stripe 协议）：header `Stripe-Signature: t=<ts>,v1=<hex>`，
 * HMAC-SHA256(`${t}.${rawPayload}`, whsec)。金额核对是独立的第二道闸
 * （签名只证来源，金额才防篡改获利——与 epay 同构）。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { parsePositiveAmount } from '../money.js';

/**
 * 元 → 分（整数串；Decimal 运算避开 ×100 浮点尾差）。
 * 零 round：非整分值结构性拒绝（面额闸上游已限两位小数；此处拒绝是防御对称，
 * 不做静默取整——静默取整 = 多收/少收）。
 */
export function stripeCentsFromAmount(amount: string): string {
  const cents = parsePositiveAmount(amount).times(100);
  if (!cents.isInteger()) {
    throw new Error('stripe amount does not convert to whole cents');
  }
  return cents.toString();
}

/** 分 → 元（整数拆合，无浮点路径；'1010' → '10.10'） */
export function stripeAmountFromCents(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents <= 0) return '0';
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

export interface StripeSignatureParts {
  t: string;
  v1: string;
}

/** 解析 `t=...,v1=...` 头（逗号分隔 k=v；缺任一即 null） */
export function parseStripeSignatureHeader(header: string): StripeSignatureParts | null {
  const parts: Record<string, string> = {};
  for (const kv of header.split(',')) {
    const eq = kv.indexOf('=');
    if (eq <= 0) continue;
    parts[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
  }
  if (!parts.t || !parts.v1) return null;
  return { t: parts.t, v1: parts.v1 };
}

/** webhook 重放窗（秒）：签名时间戳偏离超过窗即拒 */
export const STRIPE_WEBHOOK_TOLERANCE_S = 300;

/** 验签：HMAC-SHA256 恒定时间比较 + 时间窗防重放（nowMs 注入可测） */
export function verifyStripeSignature(
  header: string,
  payload: string,
  secret: string,
  nowMs: number,
): boolean {
  const parts = parseStripeSignatureHeader(header);
  if (!parts) return false;
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - timestamp) > STRIPE_WEBHOOK_TOLERANCE_S) return false;
  const expected = createHmac('sha256', secret).update(`${parts.t}.${payload}`).digest('hex');
  const a = Buffer.from(expected, 'utf-8');
  const b = Buffer.from(parts.v1, 'utf-8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface StripeCheckoutEvent {
  /** Checkout Session id（providerOrderId） */
  sessionId: string;
  /** 商户订单号（client_reference_id = payment_orders.id） */
  orderId: string;
  /** 实付金额（元，字符串）——与订单 amount 核对 */
  paidAmount: string;
}

/**
 * webhook 事件体 → 归一载荷。completed 对延迟支付方式不等于已到账，必须同时
 * 验 payment_status=paid、mode=payment、currency=注入币种（币种单真相：与装配
 * 的 PaymentsDeps.currency 同源注入，不在本层写死 'cny'）；否则提前赠送余额会
 * 形成资损。只提取不判定：金额核对在 application（需要订单真相）。
 */
export function parseStripeEvent(payload: string, currency: string): StripeCheckoutEvent | null {
  let event: {
    type?: string;
    data?: {
      object?: {
        id?: string;
        client_reference_id?: string;
        amount_total?: number;
        payment_status?: string;
        mode?: string;
        currency?: string;
        metadata?: Record<string, string>;
      };
    };
  };
  try {
    event = JSON.parse(payload) as typeof event;
  } catch {
    return null;
  }
  if (
    event.type !== 'checkout.session.completed' &&
    event.type !== 'checkout.session.async_payment_succeeded'
  ) {
    return null;
  }
  const obj = event.data?.object ?? {};
  const orderId = obj.client_reference_id ?? obj.metadata?.order_id;
  const amountTotal = obj.amount_total;
  if (
    !obj.id ||
    !orderId ||
    typeof amountTotal !== 'number' ||
    !Number.isSafeInteger(amountTotal) ||
    amountTotal <= 0 ||
    obj.payment_status !== 'paid' ||
    obj.mode !== 'payment' ||
    obj.currency?.toLowerCase() !== currency.toLowerCase()
  ) {
    return null;
  }
  return {
    sessionId: obj.id,
    orderId,
    paidAmount: stripeAmountFromCents(amountTotal),
  };
}
