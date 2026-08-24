/**
 * 推荐域规则:aff 码编解码(纯函数往返)、钱包幂等键构造器(单一真相,
 * 修复 v1 client-api 与 worker 各写一份前缀的漂移面)、佣金计算。
 */
import Decimal from 'decimal.js';
import { FIELD_LIMITS } from './fields.js';

/** userId → aff 码:`u` + base36(v1 domain/referral.ts) */
export function encodeAffCode(userId: number): string {
  return `u${userId.toString(36)}`;
}

/** aff 码 → userId;畸形(空/无 u 前缀/u0/非 base36/超长)返回 null */
export function decodeAffCode(code: string): number | null {
  if (!code.startsWith('u')) return null;
  if (code.length < 2 || code.length > FIELD_LIMITS.affCode) return null;
  const digits = code.slice(1);
  if (!/^[0-9a-z]+$/.test(digits)) return null;
  const userId = parseInt(digits, 36);
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  // 往返封闭性:同值重编码必须等于输入(拒绝前导零等非规范形态)
  if (encodeAffCode(userId) !== code) return null;
  return userId;
}

/** 开户赠送幂等锚:gift 资金流 `signup:{userId}`(v1 等价) */
export function signupGiftRefId(userId: number): string {
  return `signup:${userId}`;
}

/** 邀请注册双方奖励幂等锚:referral 资金流 `referral-signup:{inviteeId}:{inviter|invitee}`(v1 等价) */
export function referralSignupRefId(inviteeId: number, side: 'inviter' | 'invitee'): string {
  return `referral-signup:${inviteeId}:${side}`;
}

/** 佣金日结幂等锚:referral 资金流 `referral-commission:{inviterId}:{yyyyMMdd}`(UTC;worker/billing 复用) */
export function commissionRefId(inviterId: number, utcDate: string): string {
  return `referral-commission:${inviterId}:${utcDate}`;
}

/** 佣金金额:窗口合计 × 比例,全精度十进制字符串(不四舍五入到分) */
export function commissionAmount(windowSpend: string, rate: string): string {
  return new Decimal(windowSpend).times(new Decimal(rate)).toString();
}

/** 邀请链接:`{frontendBaseUrl}/register?aff={code}`(基址由调用方注入,v1 写死 localhost 兜底已清除) */
export function inviteUrl(frontendBaseUrl: string, affCode: string): string {
  return `${frontendBaseUrl}/register?aff=${affCode}`;
}
