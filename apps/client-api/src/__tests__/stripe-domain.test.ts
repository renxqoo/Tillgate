/**
 * Stripe 协议纯规则单元套件（无 IO 无 PG）：分转换 / 签名头解析 /
 * HMAC 验签（恒定时间 + 重放窗）/ 事件归一（只认 checkout.session.completed）。
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parseStripeEvent,
  parseStripeSignatureHeader,
  stripeAmountFromCents,
  stripeCentsFromAmount,
  verifyStripeSignature,
} from '../domain/stripe.js';

const SECRET = 'whsec_unit';
const NOW = 1_755_000_000_000; // 固定时钟（重放窗判定可测）

function sign(payload: string, secret = SECRET, t = NOW / 1000): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

describe('金额分转换', () => {
  it('元→分：整数/两位小数/一位小数全整数路径（无浮点尾差）', () => {
    expect(stripeCentsFromAmount('10')).toBe('1000');
    expect(stripeCentsFromAmount('10.10')).toBe('1010');
    expect(stripeCentsFromAmount('0.05')).toBe('5');
    expect(stripeCentsFromAmount('12345.67')).toBe('1234567');
  });

  it('分→元：补零两位小数；非正数/非安全整数归零', () => {
    expect(stripeAmountFromCents(1010)).toBe('10.10');
    expect(stripeAmountFromCents(5)).toBe('0.05');
    expect(stripeAmountFromCents(100000)).toBe('1000.00');
    expect(stripeAmountFromCents(0)).toBe('0');
    expect(stripeAmountFromCents(-1)).toBe('0');
    expect(stripeAmountFromCents(1.5)).toBe('0');
  });

  it('往返一致：元→分→元（两位小数域）', () => {
    for (const amount of ['1', '1.01', '99.99', '100000']) {
      expect(stripeAmountFromCents(Number(stripeCentsFromAmount(amount)))).toBe(
        Number(amount).toFixed(2),
      );
    }
  });
});

describe('签名头解析', () => {
  it('t/v1 齐全（含空格容错）', () => {
    expect(parseStripeSignatureHeader('t=123,v1=abc')).toEqual({ t: '123', v1: 'abc' });
    expect(parseStripeSignatureHeader('t=123, v1=abc')).toEqual({ t: '123', v1: 'abc' });
  });

  it('缺 t / 缺 v1 / 空头 → null', () => {
    expect(parseStripeSignatureHeader('v1=abc')).toBeNull();
    expect(parseStripeSignatureHeader('t=123')).toBeNull();
    expect(parseStripeSignatureHeader('')).toBeNull();
    expect(parseStripeSignatureHeader('garbage')).toBeNull();
  });
});

describe('webhook 验签', () => {
  const payload = JSON.stringify({ type: 'checkout.session.completed' });

  it('合法签名通过', () => {
    expect(verifyStripeSignature(sign(payload), payload, SECRET, NOW)).toBe(true);
  });

  it('错密钥 / 篡改载荷 / 篡改签名 → 拒', () => {
    expect(verifyStripeSignature(sign(payload, 'whsec_other'), payload, SECRET, NOW)).toBe(false);
    expect(verifyStripeSignature(sign(payload), payload + ' ', SECRET, NOW)).toBe(false);
    const good = sign(payload);
    const bad = good.slice(0, -2) + 'zz';
    expect(verifyStripeSignature(bad, payload, SECRET, NOW)).toBe(false);
  });

  it('重放窗：超出 300 秒（过去/未来）→ 拒；窗内通过', () => {
    const past = sign(payload, SECRET, NOW / 1000 - 301);
    expect(verifyStripeSignature(past, payload, SECRET, NOW)).toBe(false);
    const future = sign(payload, SECRET, NOW / 1000 + 301);
    expect(verifyStripeSignature(future, payload, SECRET, NOW)).toBe(false);
    const edge = sign(payload, SECRET, NOW / 1000 - 300);
    expect(verifyStripeSignature(edge, payload, SECRET, NOW)).toBe(true);
  });

  it('非数字时间戳 → 拒', () => {
    expect(verifyStripeSignature('t=abc,v1=def', payload, SECRET, NOW)).toBe(false);
  });
});

const buildEvent = (obj: Record<string, unknown>, type = 'checkout.session.completed') =>
  JSON.stringify({ type, data: { object: obj } });

describe('事件归一', () => {
  const event = buildEvent;

  it('happy path：session id + 商户单号 + 分→元金额', () => {
    const parsed = parseStripeEvent(
      event({ id: 'cs_1', client_reference_id: 'order-1', amount_total: 1010 }),
    );
    expect(parsed).toEqual({ sessionId: 'cs_1', orderId: 'order-1', paidAmount: '10.10' });
  });

  it('client_reference_id 缺失时回落 metadata.order_id', () => {
    const parsed = parseStripeEvent(
      event({ id: 'cs_2', amount_total: 500, metadata: { order_id: 'order-2' } }),
    );
    expect(parsed!.orderId).toBe('order-2');
  });

  it('非目标事件类型 / 缺字段 / 坏 JSON → null', () => {
    expect(parseStripeEvent(event({ id: 'cs', client_reference_id: 'o', amount_total: 1 }, 'payment_intent.succeeded'))).toBeNull();
    expect(parseStripeEvent(event({ client_reference_id: 'o', amount_total: 1 }))).toBeNull();
    expect(parseStripeEvent(event({ id: 'cs', amount_total: 1 }))).toBeNull();
    expect(parseStripeEvent(event({ id: 'cs', client_reference_id: 'o' }))).toBeNull();
    expect(parseStripeEvent('{not json')).toBeNull();
    expect(parseStripeEvent('{}')).toBeNull();
  });
});
