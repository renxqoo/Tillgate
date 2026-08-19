/** 币种解析：显式传入优先，缺省取装配币种——fail-closed 白名单校验。 */
import { assertCurrency, type WalletGuards } from '@ai-gateway/domain';

export function resolveCurrency(
  guards: WalletGuards,
  defaultCurrency: string,
  input: { currency?: string },
): string {
  const currency = input.currency ?? defaultCurrency;
  assertCurrency(guards, currency);
  return currency;
}
