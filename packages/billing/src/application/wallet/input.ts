/**
 * 动词入参契约共享件：币种解析、幂等键校验、包内事务通道。
 */
import type { WalletGuards } from '../../domain/wallet/guards.js';
import { assertCurrency, assertRefId, assertRefType } from '../../domain/wallet/guards.js';
import type { WalletTx } from '../../ports/wallet-store.js';

/** 币种解析：显式传入优先，缺省取装配币种——fail-closed 白名单校验 */
export function resolveCurrency(
  guards: WalletGuards,
  defaultCurrency: string,
  input: { currency?: string },
): string {
  const currency = input.currency ?? defaultCurrency;
  assertCurrency(guards, currency);
  return currency;
}

/** 幂等键契约：refType 白名单 + refId 形状（1-128 字符） */
export function assertRefKey(guards: WalletGuards, refType: string, refId: string): void {
  assertRefType(guards, refType);
  assertRefId(refId);
}

/**
 * 包内上层用例共享事务的内部通道（如计费授权在同一事务内编排钱包动词）。
 * WalletTx 仅在包内流动；root index 不导出其类型与构造途径。
 */
export interface TxChannel {
  tx?: WalletTx;
}
