/**
 * settings postgres 适配器：system_configs KV 的 billing_timezone 读写。
 * 键与网关热路径读取器（apps/gateway billing-timezone.ts）共用同一约定；
 * 值形状 {"timezone":"<IANA 名>"}——jsonb，留扩展位。
 */
import { eq } from 'drizzle-orm';
import type { DbLike } from '@tokenlens/db';
import { systemConfigs } from '@tokenlens/db';
import type { SettingsStore } from '../../ports/settings-store';

export const BILLING_TIMEZONE_KEY = 'billing_timezone';

interface BillingTimezoneValue {
  timezone?: unknown;
}

export const postgresSettingsStore: SettingsStore = {
  async readBillingTimezone(db) {
    const row = await db.query.systemConfigs.findFirst({
      where: eq(systemConfigs.key, BILLING_TIMEZONE_KEY),
      columns: { value: true },
    });
    const value = (row?.value ?? null) as BillingTimezoneValue | null;
    return typeof value?.timezone === 'string' && value.timezone.length > 0
      ? value.timezone
      : null;
  },

  async updateBillingTimezone(db, input) {
    await db
      .insert(systemConfigs)
      .values({
        key: BILLING_TIMEZONE_KEY,
        value: { timezone: input.timezone },
        updatedByAdminId: input.adminId,
      })
      .onConflictDoUpdate({
        target: systemConfigs.key,
        set: { value: { timezone: input.timezone }, updatedByAdminId: input.adminId },
      });
  },
};
