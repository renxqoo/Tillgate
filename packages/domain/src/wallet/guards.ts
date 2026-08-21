/**
 * fail-closed 白名单（装配配置）：未声明的 refType / 币种 / 内部科目一律结构性拒绝。
 * 三张白名单堵三类静默错误（未知业务域入账、拼错币种、拼错科目写飞资金）。
 */
import { InvalidRefError } from './errors.js';

export interface WalletGuards {
  /** 允许的业务域（refType），如 ['billing', 'topup', 'admin'] */
  refTypes: readonly string[];
  /** 允许的币种（ISO-4217 子集），如 ['CNY'] */
  currencies: readonly string[];
  /** 允许的内部科目代码，如 ['outside', 'platform_revenue'] */
  internalAccounts: readonly string[];
}

export function assertRefType(guards: WalletGuards, refType: string): void {
  if (!guards.refTypes.includes(refType)) throw new InvalidRefError('invalid_ref_type');
}

export function assertCurrency(guards: WalletGuards, currency: string): void {
  if (!guards.currencies.includes(currency)) throw new InvalidRefError('invalid_currency');
}

export function assertInternalCode(guards: WalletGuards, code: string): void {
  if (!guards.internalAccounts.includes(code)) throw new InvalidRefError('invalid_internal_code');
}

/** refId 契约：1-128 可见字符（幂等键是调用方设计责任，空/超长即拒绝） */
export function assertRefId(refId: string): void {
  if (refId.length < 1 || refId.length > 128) throw new InvalidRefError('invalid_ref_id');
}
