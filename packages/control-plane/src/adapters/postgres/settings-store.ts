/**
 * settings postgres 适配器：system_configs KV 的 billing_timezone 与
 * debit_floor_default 读写。时区键与网关热路径读取器（apps/gateway
 * billing-timezone.ts）共用同一约定；地板键单一真相在 billing/debit-floor.ts
 * （billing 钱包适配器建户套默认同键同形状）。值形状均为单字段 jsonb，留扩展位。
 */
import { eq } from 'drizzle-orm';
import { systemConfigs } from '@tillgate/db';
import {
  BILLING_RESERVATION_LIMIT_KEY,
  BILLING_RESERVATION_POLICY_KEY,
  DEBIT_FLOOR_DEFAULT_KEY,
  PLATFORM_CURRENCY_KEY,
  parseDebitFloorDefault,
  parsePlatformCurrencySetting,
  parseReservationLimitSetting,
  parseReservationPolicySetting,
} from '@tillgate/billing';
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
    return typeof value?.timezone === 'string' && value.timezone.length > 0 ? value.timezone : null;
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

  async readDebitFloorDefault(db) {
    const row = await db.query.systemConfigs.findFirst({
      where: eq(systemConfigs.key, DEBIT_FLOOR_DEFAULT_KEY),
      columns: { value: true },
    });
    // 形状与金额域校验复用 billing 单一实现（负数/垃圾串 = 未配置语义）
    return parseDebitFloorDefault(row?.value);
  },

  async updateDebitFloorDefault(db, input) {
    await db
      .insert(systemConfigs)
      .values({
        key: DEBIT_FLOOR_DEFAULT_KEY,
        value: { floor: input.floor },
        updatedByAdminId: input.adminId,
      })
      .onConflictDoUpdate({
        target: systemConfigs.key,
        set: {
          value: { floor: input.floor },
          updatedAt: new Date(),
          updatedByAdminId: input.adminId,
        },
      });
  },

  async readBillingReservationPolicy(db) {
    const row = await db.query.systemConfigs.findFirst({
      where: eq(systemConfigs.key, BILLING_RESERVATION_POLICY_KEY),
      columns: { value: true },
    });
    // 值域校验复用 billing 单一实现（零/垃圾金额 = 未配置语义回落 full）
    return parseReservationPolicySetting(row?.value);
  },

  async readBillingReservationLimit(db) {
    const row = await db.query.systemConfigs.findFirst({
      where: eq(systemConfigs.key, BILLING_RESERVATION_LIMIT_KEY),
      columns: { value: true },
    });
    return parseReservationLimitSetting(row?.value);
  },

  async updateBillingReservationLimit(db, input) {
    await db
      .insert(systemConfigs)
      .values({
        key: BILLING_RESERVATION_LIMIT_KEY,
        value: { limit: input.limit },
        updatedByAdminId: input.adminId,
      })
      .onConflictDoUpdate({
        target: systemConfigs.key,
        set: {
          value: { limit: input.limit },
          updatedAt: new Date(),
          updatedByAdminId: input.adminId,
        },
      });
  },

  async readPlatformCurrency(db) {
    const row = await db.query.systemConfigs.findFirst({
      where: eq(systemConfigs.key, PLATFORM_CURRENCY_KEY),
      columns: { value: true },
    });
    return parsePlatformCurrencySetting(row?.value);
  },

  async updatePlatformCurrency(db, input) {
    await db
      .insert(systemConfigs)
      .values({
        key: PLATFORM_CURRENCY_KEY,
        value: { currency: input.currency },
        updatedByAdminId: input.adminId,
      })
      .onConflictDoUpdate({
        target: systemConfigs.key,
        set: {
          value: { currency: input.currency },
          updatedAt: new Date(),
          updatedByAdminId: input.adminId,
        },
      });
  },

  async updateBillingReservationPolicy(db, input) {
    await db
      .insert(systemConfigs)
      .values({
        key: BILLING_RESERVATION_POLICY_KEY,
        value: input.policy,
        updatedByAdminId: input.adminId,
      })
      .onConflictDoUpdate({
        target: systemConfigs.key,
        set: {
          value: input.policy,
          updatedAt: new Date(),
          updatedByAdminId: input.adminId,
        },
      });
  },
};
