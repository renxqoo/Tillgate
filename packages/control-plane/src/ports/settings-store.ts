/**
 * SettingsStore port：运营系统配置（system_configs KV）的持久化边界。
 * 当前承载 billing_timezone（全系统统一计费时区——schedule 分时段策略的
 * 墙钟口径）；网关热路径读经自身 TTL 缓存直连本表，admin 面读写走本 port。
 */
import type { DbLike } from '@tokenlens/db';

export interface SettingsStore {
  /** 计费时区读（未配置/形状异常 = null，消费方回落装配缺省） */
  readBillingTimezone(db: DbLike): Promise<string | null>;
  /** 计费时区写（upsert system_configs['billing_timezone']；adminId 进操作人列） */
  updateBillingTimezone(
    db: DbLike,
    input: { timezone: string; adminId: number | null },
  ): Promise<void>;
}
