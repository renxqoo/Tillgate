/**
 * 预扣策略运营配置（system_configs KV 'billing_reservation_policy'）：
 * full = 全额保守预扣（默认，零垫付风险）；fixed = 固定门槛预扣（厂商式准入——
 * 余额过门槛即放行，实际用量后付费结算，超出部分受 debit_floor 地板封底）。
 * 键与值域解析的单一真相在本文件：admin settings 面写入、网关热路径 TTL 读。
 */
import { parsePositiveAmount } from '../../domain/money.js';
import type { FundingReservationPolicy } from '../../domain/rating/calculate.js';

export const BILLING_RESERVATION_POLICY_KEY = 'billing_reservation_policy';

/** KV 值形状（jsonb，留扩展位） */
interface ReservationPolicyValue {
  mode?: unknown;
  amount?: unknown;
}

/**
 * 值域解析：full 原样通过；fixed 需正十进制金额（0 拒绝——fixed 0 等于
 * 零门槛无限放行）。形状/值域异常返回 null（消费方按未配置语义回落）。
 */
export function parseReservationPolicySetting(raw: unknown): FundingReservationPolicy | null {
  if (raw == null || typeof raw !== 'object') return null;
  const { mode, amount } = raw as ReservationPolicyValue;
  if (mode === 'full') return { mode: 'full' };
  if (mode !== 'fixed' || typeof amount !== 'string' || amount.length === 0) return null;
  try {
    if (parsePositiveAmount(amount).isZero()) return null;
    return { mode: 'fixed', amount };
  } catch {
    return null;
  }
}

export const BILLING_RESERVATION_LIMIT_KEY = 'billing_reservation_limit';

/** 单笔预估敞口上限缺省（CNY；KV 未配置时的回落——防单笔巨亏的结构性保险丝） */
export const DEFAULT_RESERVATION_LIMIT = '1000';

interface ReservationLimitValue {
  limit?: unknown;
}

/** 值域解析：正十进制金额（0/负/垃圾 → null = 消费方回落缺省） */
export function parseReservationLimitSetting(raw: unknown): string | null {
  if (raw == null || typeof raw !== 'object') return null;
  const { limit } = raw as ReservationLimitValue;
  if (typeof limit !== 'string' || limit.length === 0) return null;
  try {
    if (parsePositiveAmount(limit).isZero()) return null;
    return limit;
  } catch {
    return null;
  }
}
