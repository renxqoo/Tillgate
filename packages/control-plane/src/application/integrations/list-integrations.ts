/**
 * 集成设置管理面列表（DESIGN §4.1）：词表全量补齐（无行 = 未配置），
 * secret 字段解密后掩码回显——响应永不包含明文或密文。
 */
import { maskIntegrationConfig } from '../../domain/integrations/masking';
import { isConfigComplete } from '../../domain/integrations/completeness';
import { specOf } from '../../domain/integrations/specs';
import { INTEGRATION_KEYS } from '../../domain/integrations/keys';
import type { IntegrationKey } from '../../domain/integrations/keys';
import type { Db } from '@tillgate/db';
import type { SecretCipher } from '../../ports/secret-cipher';
import type {
  IntegrationSettingsRow,
  IntegrationSettingsStore,
} from '../../ports/integration-settings-store';

export interface IntegrationListDeps {
  readonly db: Db;
  readonly stores: { readonly integrationSettings: IntegrationSettingsStore };
  readonly cipher: SecretCipher;
}

export interface IntegrationListItem {
  readonly key: IntegrationKey;
  readonly enabled: boolean;
  readonly configured: boolean;
  /** 规格内字段全集：非 secret 原样；secret 掩码（未设置 null；解密失败归 '****'） */
  readonly config: Record<string, string | null>;
  /** 已设置的 secret 字段名清单（UI write-only 提示用） */
  readonly secretsSet: readonly string[];
  readonly rotatedAt: string | null;
  readonly updatedAt: string | null;
  readonly updatedByAdminId: number | null;
}

export async function listIntegrations(
  deps: IntegrationListDeps,
): Promise<{ integrations: readonly IntegrationListItem[] }> {
  const rows = await deps.stores.integrationSettings.readAll(deps.db);
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const integrations = INTEGRATION_KEYS.map((key) => itemOf(deps, key, byKey.get(key)));
  return { integrations };
}

function itemOf(
  deps: IntegrationListDeps,
  key: IntegrationKey,
  row: IntegrationSettingsRow | undefined,
): IntegrationListItem {
  const spec = specOf(key);
  const config = row?.config ?? {};
  const decrypt = (_field: string, value: string): string | null => {
    try {
      return deps.cipher.decrypt(value);
    } catch {
      // 单字段密文异常不炸整个设置页：掩码降级为全遮（快照/写入路径仍 fail-loud）
      return null;
    }
  };
  const masked = maskIntegrationConfig(spec, config, decrypt);
  return {
    key,
    enabled: row?.enabled ?? false,
    configured: isConfigComplete(spec, config),
    config: masked,
    secretsSet: spec.fields
      .filter((f) => f.secret && typeof config[f.name] === 'string')
      .map((f) => f.name),
    rotatedAt: row?.rotatedAt != null ? row.rotatedAt.toISOString() : null,
    updatedAt: row != null && row.updatedAt.getTime() > 0 ? row.updatedAt.toISOString() : null,
    updatedByAdminId: row?.updatedByAdminId ?? null,
  };
}
