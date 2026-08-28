/**
 * 平台币种读（admin settings 面）：未配置/值域异常回落缺省 CNY。
 */
import { DEFAULT_PLATFORM_CURRENCY } from '@tillgate/billing';
import type { Db } from '@tillgate/db';
import type { SettingsStore } from '../../ports/settings-store';

export interface ReadPlatformCurrencyDeps {
  readonly db: Db;
  readonly stores: { readonly settings: SettingsStore };
}

export async function readPlatformCurrency(
  deps: ReadPlatformCurrencyDeps,
): Promise<{ currency: string }> {
  return {
    currency:
      (await deps.stores.settings.readPlatformCurrency(deps.db)) ?? DEFAULT_PLATFORM_CURRENCY,
  };
}
