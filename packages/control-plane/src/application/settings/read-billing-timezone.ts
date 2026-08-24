/**
 * 计费时区读（admin settings 面）：全系统统一分时段计价的墙钟口径。
 * 返回 null = 未配置（消费方回落装配缺省，如网关 BILLING_TIMEZONE_DEFAULT）。
 */
import type { Db } from '@tillgate/db';
import type { SettingsStore } from '../../ports/settings-store';

export interface ReadBillingTimezoneDeps {
  readonly db: Db;
  readonly stores: { readonly settings: SettingsStore };
}

export async function readBillingTimezone(
  deps: ReadBillingTimezoneDeps,
): Promise<{ timezone: string | null }> {
  return { timezone: await deps.stores.settings.readBillingTimezone(deps.db) };
}
