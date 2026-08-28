/**
 * SettingsStore port：运营系统配置（system_configs KV）的持久化边界。
 * 当前承载 billing_timezone（全系统统一计费时区——schedule 分时段策略的
 * 墙钟口径）、debit_floor_default（透支地板全局默认——新钱包套用基准）与
 * billing_reservation_policy（预扣策略——full 全额保守 / fixed 固定门槛厂商式）；
 * 键单一真相在 billing（网关热路径 TTL 读同键同形状），admin 面读写走本 port。
 */
import type { DbLike } from '@tillgate/db';
import type { FundingReservationPolicy } from '@tillgate/billing';

export interface SettingsStore {
  /** 计费时区读（未配置/形状异常 = null，消费方回落装配缺省） */
  readBillingTimezone(db: DbLike): Promise<string | null>;
  /** 计费时区写（upsert system_configs['billing_timezone']；adminId 进操作人列） */
  updateBillingTimezone(
    db: DbLike,
    input: { timezone: string; adminId: number | null },
  ): Promise<void>;

  /** 透支地板默认读（未配置/形状/金额异常 = null，消费方回落 "0" 不透支） */
  readDebitFloorDefault(db: DbLike): Promise<string | null>;
  /** 透支地板默认写（upsert system_configs['debit_floor_default']；adminId 进操作人列） */
  updateDebitFloorDefault(
    db: DbLike,
    input: { floor: string; adminId: number | null },
  ): Promise<void>;

  /** 预扣策略读（未配置/值域异常 = null，消费方回落 full 保守预扣） */
  readBillingReservationPolicy(db: DbLike): Promise<FundingReservationPolicy | null>;
  /** 预扣策略写（upsert system_configs['billing_reservation_policy']；adminId 进操作人列） */
  updateBillingReservationPolicy(
    db: DbLike,
    input: { policy: FundingReservationPolicy; adminId: number | null },
  ): Promise<void>;

  /** 单笔预估敞口上限读（未配置/值域异常 = null，消费方回落缺省 1000） */
  readBillingReservationLimit(db: DbLike): Promise<string | null>;
  /** 单笔预估敞口上限写（upsert system_configs['billing_reservation_limit']） */
  updateBillingReservationLimit(
    db: DbLike,
    input: { limit: string; adminId: number | null },
  ): Promise<void>;

  /** 平台币种读（未配置/值域异常 = null，消费方回落缺省 CNY） */
  readPlatformCurrency(db: DbLike): Promise<string | null>;
  /** 平台币种写（upsert system_configs['platform_currency']；写一次守卫在用例） */
  updatePlatformCurrency(
    db: DbLike,
    input: { currency: string; adminId: number | null },
  ): Promise<void>;
}
