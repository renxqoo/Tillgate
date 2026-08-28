/**
 * 单笔预估敞口上限读（admin settings 面 + 网关基准）：未配置/值域异常回落缺省
 * 1000（防单笔巨亏的结构性保险丝——回落方向保守：拒绝超大预估请求）。
 */
import { DEFAULT_RESERVATION_LIMIT } from '@tillgate/billing';
import type { Db } from '@tillgate/db';
import type { SettingsStore } from '../../ports/settings-store';

export interface ReadBillingReservationLimitDeps {
  readonly db: Db;
  readonly stores: { readonly settings: SettingsStore };
}

export async function readBillingReservationLimit(
  deps: ReadBillingReservationLimitDeps,
): Promise<{ limit: string }> {
  return {
    limit:
      (await deps.stores.settings.readBillingReservationLimit(deps.db)) ??
      DEFAULT_RESERVATION_LIMIT,
  };
}
