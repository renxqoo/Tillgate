/**
 * 透支地板默认读（admin settings 面）：结算超收的全局透支上界基准。
 * 未配置/形状异常回落 "0"（不透支——fail-closed，绝不把垃圾值当默认放行）。
 */
import type { Db } from '@tillgate/db';
import type { SettingsStore } from '../../ports/settings-store';

export interface ReadDebitFloorDefaultDeps {
  readonly db: Db;
  readonly stores: { readonly settings: SettingsStore };
}

export async function readDebitFloorDefault(
  deps: ReadDebitFloorDefaultDeps,
): Promise<{ floor: string }> {
  return { floor: (await deps.stores.settings.readDebitFloorDefault(deps.db)) ?? '0' };
}
