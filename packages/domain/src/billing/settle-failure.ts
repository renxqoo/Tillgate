/**
 * 结算失败处置策略（纯函数）：一次结算抛错后「重试退避」还是「死信」。
 *
 *   死信家族（确定性失败，重试不可自愈）：毒收据、用户错配、配置事故、
 *   各域不变量破坏（billing / wallet / channel-budget）
 *   其余（PG 抖动、网络、守卫竞态输家等瞬态）→ 指数退避重试；
 *   尝试次数耗尽 → 死信人工复核。
 */
import { BillingConfigurationError, PoisonReceiptError, ReceiptUserMismatchError } from '../rating/errors.js';
import { BillingInvariantError } from './errors.js';
import { WalletInvariantError } from '../wallet/errors.js';
import { ChannelExposureInvariantError } from '../channel-budget/errors.js';

/** 结算收尾天然跨 billing 与渠道运营资金两域——billing 允许下行引用 channel-budget 错误家谱 */
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

const DEAD_FAMILY = [
  PoisonReceiptError,
  ReceiptUserMismatchError,
  BillingConfigurationError,
  BillingInvariantError,
  WalletInvariantError,
  ChannelExposureInvariantError,
] as const;

export function settleFailurePolicy(
  error: unknown,
  input: SettleFailurePolicyInput,
): SettleFailureDecision {
  const failureClass = error instanceof Error ? error.name : typeof error;
  if (DEAD_FAMILY.some((type) => error instanceof type)) {
    return { dead: true, failureClass };
  }
  if (input.attempt >= input.maxAttempts) {
    return { dead: true, failureClass: `${failureClass}_max_attempts` };
  }
  const retryInMs = Math.min(input.maxDelayMs, input.baseDelayMs * 2 ** (input.attempt - 1));
  return { dead: false, retryInMs, failureClass };
}
