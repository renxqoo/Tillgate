/**
 * 邀请返利纯规则（无 IO）：aff 码编解码 + 佣金自然键。
 * aff 码 = 「u{userId 的 base36}」——无新列，userId 是唯一事实源
 * （同样的编码也是 v1 的既有格式，历史邀请链接继续有效）。
 * 入账幂等在 wallet 自然键（refType 'referral' + refId + kind credit 唯一）。
 */
import { Decimal, parsePositiveAmount } from '@ai-gateway/domain';

/** userId → aff 码 */
export function encodeAffCode(userId: number): string {
  return `u${userId.toString(36)}`;
}

/** aff 码 → userId（畸形/自环外的非法形态返回 null） */
export function decodeAffCode(code: string): number | null {
  if (!/^u[0-9a-z]+$/i.test(code)) return null;
  const id = Number.parseInt(code.slice(1), 36);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** 注册奖励自然键（与 v1 相同格式：同一被邀人两侧各只发一次） */
export const signupBonusRefId = (inviteeId: number, side: 'inviter' | 'invitee') =>
  `referral-signup:${inviteeId}:${side}`;

/** 佣金金额：被邀人消费合计 × 比例（全精度 Decimal；≤0 由调用方跳过） */
export function commissionAmount(total: string, rate: number): string {
  return parsePositiveAmount(total).times(rate).toString();
}

/** 日结窗口的佣金合计为正才派发（Decimal 判定） */
export function isPositiveAmount(amount: string): boolean {
  try {
    return new Decimal(amount).greaterThan(0);
  } catch {
    return false;
  }
}
