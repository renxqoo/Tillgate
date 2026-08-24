/**
 * integration_settings postgres 适配器：行读写（密文原样透传）。
 * 真实 SQL 行为等价由 __test__/postgres.real.test.ts 承担（默认门禁排除）。
 */
import { integrationSettings } from '@tillgate/db';

import { isIntegrationKey } from '../../domain/integrations/keys';
import type {
  IntegrationSettingsStore,
  IntegrationSettingsUpsert,
} from '../../ports/integration-settings-store';

export const postgresIntegrationSettingsStore: IntegrationSettingsStore = {
  async readAll(db) {
    const rows = await db.select().from(integrationSettings);
    // 词表外的历史脏行防御性丢弃（DB CHECK 已拦截写入）
    return rows.flatMap((row) => {
      if (!isIntegrationKey(row.key)) return [];
      return [
        {
          key: row.key,
          enabled: row.enabled,
          config: (row.config ?? {}) as Record<string, unknown>,
          previousSecrets: (row.previousSecrets ?? null) as Record<string, string> | null,
          rotatedAt: row.rotatedAt ?? null,
          updatedByAdminId: row.updatedByAdminId ?? null,
          updatedAt: row.updatedAt,
        },
      ];
    });
  },

  async upsert(db, input: IntegrationSettingsUpsert) {
    await db
      .insert(integrationSettings)
      .values({
        key: input.key,
        enabled: input.enabled,
        config: input.config,
        previousSecrets: input.previousSecrets,
        rotatedAt: input.rotatedAt,
        updatedByAdminId: input.adminId,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: integrationSettings.key,
        set: {
          enabled: input.enabled,
          config: input.config,
          previousSecrets: input.previousSecrets,
          rotatedAt: input.rotatedAt,
          updatedByAdminId: input.adminId,
          updatedAt: new Date(),
        },
      });
  },
};
