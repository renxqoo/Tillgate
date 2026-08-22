/**
 * 易支付协议纯规则（无 IO）：参数签名/验签 + 回调载荷归一。
 * 协议约定：键名字典序拼 query（剔 sign/sign_type/空值）+ 商户密钥 → MD5。
 * 金额核对是独立的第二道闸（签名只证来源，金额才防篡改获利）。
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/** 易支付参数签名（键序 MD5，剔除 sign/sign_type/空值——通用协议约定） */
export function epaySign(params: Record<string, string>, key: string): string {
  const query = Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'sign_type' && params[k] !== '' && params[k] !== undefined)
    .toSorted()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return createHash('md5').update(`${query}${key}`).digest('hex');
}

/** 验签（恒定时间比较——`===` 按字符短路会泄漏前缀；缺 sign 即拒） */
export function epayVerify(params: Record<string, string>, key: string): boolean {
  const provided = params.sign;
  if (!provided) return false;
  const expected = epaySign(params, key);
  const a = Buffer.from(provided, 'utf-8');
  const b = Buffer.from(expected, 'utf-8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 提交型网关支持的支付类型（易支付 type 参数；充值只走即时到账） */
export const EPAY_PAY_TYPES = ['alipay', 'wxpay', 'qqpay'] as const;
export type EpayPayType = (typeof EPAY_PAY_TYPES)[number];

export interface EpayNotifyPayload {
  providerOrderId: string;
  /** 渠道侧订单状态（易支付：TRADE_SUCCESS 才算支付成功） */
  tradeStatus: string;
  /** 实付金额（元，字符串）——与订单 amount 核对 */
  amount: string;
}

/**
 * 回调查询参数 → 归一载荷（取协议字段；外类型透传忽略）。
 * 只提取不判定：金额/状态/订单的核对在 application（需要订单真相）。
 */
export function parseEpayNotify(query: Record<string, string>): EpayNotifyPayload | null {
  const providerOrderId = query.out_trade_no;
  if (!providerOrderId) return null;
  return {
    providerOrderId,
    tradeStatus: query.trade_status ?? '',
    amount: query.money ?? '',
  };
}
