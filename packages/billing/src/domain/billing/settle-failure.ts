/**
 * 结算失败处置策略（纯函数）：一次结算抛错后「重试退避」还是「死信」。
 *
 *   死信家族（确定性失败，重试不可自愈）：毒收据/用户错配（billing.poison_receipt /
 *   billing.receipt_user_mismatch）、配置事故（billing.invalid_* 家族）、
 *   一切不变量破坏（DefectError——billing/wallet/未来的 channel-budget 同归红灯）。
 *   其余（PG 抖动、网络、守卫竞态输家等瞬态）→ 指数退避重试；
 *   尝试次数耗尽 → 死信人工复核。
 *
 * 旧仓按错误类 instanceof 判死信（跨包类匹配的 B6 病灶）；新契约按三性/目录码判定，
 * 渠道侧不变量错误只要以 DefectError 表达即自动进死信家族——无需下行依赖。
 */
import { isBusinessError, isDefectError } from '@tillgate/errors';

export type SettleFailureDecision =
  | { dead: true; failureClass: string }
  | { dead: false; retryInMs: number; failureClass: string };

/** 策略参数（装配配置——次数/退避不写死） */
export interface SettleFailurePolicyConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface SettleFailurePolicyInput extends SettleFailurePolicyConfig {
  /** 已尝试次数（含本次，从 1 起） */
  attempt: number;
}

/** 死信家族的目录码前缀（poison_receipt / receipt_user_mismatch / 配置事故族） */
const DEAD_CODE_PREFIXES = [
  'billing.poison_receipt',
  'billing.receipt_user_mismatch',
  'billing.invalid_',
  'billing.reservation_limit_exceeded',
  'billing.unknown_reservation_strategy',
];

export function isDeadLetterFamily(error: unknown): boolean {
  if (isDefectError(error)) return true;
  if (isBusinessError(error)) {
    return DEAD_CODE_PREFIXES.some((prefix) => error.code.startsWith(prefix));
  }
  return false;
}

export function settleFailurePolicy(
  error: unknown,
  input: SettleFailurePolicyInput,
): SettleFailureDecision {
  const failureClass = error instanceof Error ? error.name : typeof error;
  if (isDeadLetterFamily(error)) {
    return { dead: true, failureClass };
  }
  // F-1 回归防护(live-fire 红队 F-1):attempt 非有限数值时退避公式产出 NaN,
  // NaN 流向 casToRetryOrDead 的 interval 乘法 SQL 会打崩失败处置事务并逃逸
  // 成进程级故障——非法计数直接死信人工复核,永不进退避路径
  if (!Number.isFinite(input.attempt) || input.attempt < 1) {
    return { dead: true, failureClass: `${failureClass}_invalid_attempt` };
  }
  if (input.attempt >= input.maxAttempts) {
    return { dead: true, failureClass: `${failureClass}_max_attempts` };
  }
  const retryInMs = Math.min(input.maxDelayMs, input.baseDelayMs * 2 ** (input.attempt - 1));
  if (!Number.isFinite(retryInMs)) {
    return { dead: true, failureClass: `${failureClass}_invalid_delay` };
  }
  return { dead: false, retryInMs, failureClass };
}
