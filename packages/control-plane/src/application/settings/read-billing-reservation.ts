/**
 * 预扣策略读（admin settings 面 + 网关基准）：未配置/值域异常回落 full
 * （保守全额预扣——fail-closed，绝不把垃圾值当 fixed 放行垫付）。
 */
import type { Db } from '@tillgate/db';
import type { FundingReservationPolicy } from '@tillgate/billing';
import type { SettingsStore } from '../../ports/settings-store';

export interface ReadBillingReservationDeps {
  readonly db: Db;
  readonly stores: { readonly settings: SettingsStore };
}

export async function readBillingReservation(
  deps: ReadBillingReservationDeps,
): Promise<{ policy: FundingReservationPolicy }> {
  return {
    policy: (await deps.stores.settings.readBillingReservationPolicy(deps.db)) ?? { mode: 'full' },
  };
}
