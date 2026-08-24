/**
 * IntegrationSettingsStore port：第三方集成动态配置（integration_settings）的持久化边界。
 * 行形状密文原样透传（secret 字段 = enc:v1 字符串）——解密归 application 快照/掩码层。
 * 消费侧运行时读经 composition 的 reader 工厂（TTL 缓存），admin 面读写走本 port。
 */
import type { DbLike } from '@tillgate/db';

import type { IntegrationKey } from '../domain/integrations/keys';

/** 行（读形状）：config/previousSecrets 的 secret 字段为 enc:v1 密文 */
export interface IntegrationSettingsRow {
  readonly key: IntegrationKey;
  readonly enabled: boolean;
  readonly config: Readonly<Record<string, unknown>>;
  readonly previousSecrets: Readonly<Record<string, string>> | null;
  readonly rotatedAt: Date | null;
  readonly updatedByAdminId: number | null;
  readonly updatedAt: Date;
}

/** 行（写形状）：整体 upsert（用例层先完成校验/加密/轮换归并） */
export interface IntegrationSettingsUpsert {
  readonly key: IntegrationKey;
  readonly enabled: boolean;
  readonly config: Readonly<Record<string, unknown>>;
  readonly previousSecrets: Readonly<Record<string, string>> | null;
  readonly rotatedAt: Date | null;
  readonly adminId: number | null;
}

export interface IntegrationSettingsStore {
  /** 全量读（≤ 词表规模 7 行）；DB CHECK 词表外的历史脏行由适配器丢弃 */
  readAll(db: DbLike): Promise<IntegrationSettingsRow[]>;
  /** 整行 upsert（主键 key） */
  upsert(db: DbLike, row: IntegrationSettingsUpsert): Promise<void>;
}
