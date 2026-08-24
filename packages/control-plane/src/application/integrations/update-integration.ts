/**
 * 集成设置写（DESIGN §4.1/§5 D5-D6）：字段三态合并（缺席=保持 / null=清除 / 值=设置）
 * → secret 加密、rotatable 旧值入双读窗 → enabled⇒完整性不变量 → 事务落库 +
 * 同事务审计（凭据属安全类变更，§5.4 强制形态）。
 *
 * 双视图纪律：merge 阶段全部用明文视图（已有 secret 先解密）；落库前一次性
 * 加密成存储视图——避免二次加密；返回的掩码项只从明文视图生成。
 */
import { isConfigComplete } from '../../domain/integrations/completeness';
import { maskIntegrationConfig } from '../../domain/integrations/masking';
import { isValidFieldValue, specOf } from '../../domain/integrations/specs';
import { isIntegrationKey } from '../../domain/integrations/keys';
import type { IntegrationKey } from '../../domain/integrations/keys';
import { controlPlaneErrors } from '../../errors';
import type { Db } from '@tillgate/db';
import type { AuditSink, AuditTxSink } from '../../ports/audit-sink';
import type { SecretCipher } from '../../ports/secret-cipher';
import type {
  IntegrationSettingsRow,
  IntegrationSettingsStore,
} from '../../ports/integration-settings-store';
import { adminIdOf, type ControlContext } from '../context';
import { emitAuditWithinTx } from '../audit';
import type { IntegrationListItem } from './list-integrations';

export interface UpdateIntegrationDeps {
  readonly db: Db;
  readonly stores: { readonly integrationSettings: IntegrationSettingsStore };
  readonly cipher: SecretCipher;
  readonly audit: AuditSink;
  readonly auditTx: AuditTxSink;
  readonly now: () => Date;
}

export interface UpdateIntegrationInput {
  readonly ctx: ControlContext;
  readonly key: string;
  readonly enabled?: boolean;
  readonly config?: Readonly<Record<string, string | null>>;
}

const CIPHERTEXT_PREFIX = 'enc:';

export async function updateIntegration(
  deps: UpdateIntegrationDeps,
  input: UpdateIntegrationInput,
): Promise<IntegrationListItem> {
  const { key, spec, existing } = await loadIntegrationRow(deps, input.key);

  // 明文视图：已有 secret 解密回明文，后续合并/校验/掩码/加密全部基于它
  const merged = mergePlaintext(deps, spec, {
    stored: existing?.config ?? {},
    submitted: input.config ?? {},
  });
  const enabled = input.enabled ?? existing?.enabled ?? false;

  if (enabled && !isConfigComplete(spec, merged)) {
    throw controlPlaneErrors.business('integration_config_incomplete', { key });
  }

  const rotation = rotateSecrets(deps, spec, { existing, merged });
  const stored = encryptSecrets(deps, spec, merged);
  const adminId = adminIdOf(input.ctx);

  const detail = auditDetail(key, {
    enabledFrom: existing?.enabled ?? false,
    enabledTo: enabled,
    changedFields: Object.keys(input.config ?? {}),
    rotatedFields: rotation.rotatedFields,
  });

  await persistIntegration(deps, {
    key,
    enabled,
    stored,
    previousSecrets: rotation.previousSecrets,
    rotatedAt: rotation.rotatedAt,
    adminId,
    detail,
  });

  return maskedResult(deps, {
    key,
    spec,
    merged,
    enabled,
    rotatedAt: rotation.rotatedAt,
    adminId,
  });
}

/** 掩码回显项（明文视图生成——响应永不带明文/密文） */
function maskedResult(
  deps: UpdateIntegrationDeps,
  state: {
    readonly key: IntegrationKey;
    readonly spec: ReturnType<typeof specOf>;
    readonly merged: Record<string, string>;
    readonly enabled: boolean;
    readonly rotatedAt: Date | null;
    readonly adminId: number | null;
  },
): IntegrationListItem {
  const { key, spec, merged } = state;
  return {
    key,
    enabled: state.enabled,
    configured: isConfigComplete(spec, merged),
    config: maskIntegrationConfig(spec, merged, (_field, value) => value),
    secretsSet: spec.fields.filter((f) => f.secret && merged[f.name] != null).map((f) => f.name),
    rotatedAt: state.rotatedAt != null ? state.rotatedAt.toISOString() : null,
    updatedAt: deps.now().toISOString(),
    updatedByAdminId: state.adminId,
  };
}

/** 前置：key 词表校验 + 现存行加载（无行 = 未配置的全新集成） */
async function loadIntegrationRow(
  deps: UpdateIntegrationDeps,
  rawKey: string,
): Promise<{
  readonly key: IntegrationKey;
  readonly spec: ReturnType<typeof specOf>;
  readonly existing: IntegrationSettingsRow | undefined;
}> {
  if (!isIntegrationKey(rawKey)) {
    throw controlPlaneErrors.business('integration_unknown', { key: rawKey });
  }
  const rows = await deps.stores.integrationSettings.readAll(deps.db);
  return { key: rawKey, spec: specOf(rawKey), existing: rows.find((row) => row.key === rawKey) };
}

/** 事务落库 + 同事务审计（凭据属安全类变更——§5.4 强制形态） */
async function persistIntegration(
  deps: UpdateIntegrationDeps,
  row: {
    readonly key: IntegrationKey;
    readonly enabled: boolean;
    readonly stored: Record<string, string>;
    readonly previousSecrets: Record<string, string> | null;
    readonly rotatedAt: Date | null;
    readonly adminId: number | null;
    readonly detail: Record<string, unknown>;
  },
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    await deps.stores.integrationSettings.upsert(tx, {
      key: row.key,
      enabled: row.enabled,
      config: row.stored,
      previousSecrets: row.previousSecrets,
      rotatedAt: row.rotatedAt,
      adminId: row.adminId,
    });
    await emitAuditWithinTx(deps.auditTx, tx, {
      actor: 'admin',
      adminId: row.adminId,
      action: 'settings.integrations.update',
      targetType: 'integration_setting',
      targetId: row.key,
      detail: row.detail,
    });
  });
}

/** 审计 detail 构造（Turnstile 停用高亮——DESIGN §5 D11 独立成函数便于读审） */
function auditDetail(
  key: IntegrationKey,
  base: {
    readonly enabledFrom: boolean;
    readonly enabledTo: boolean;
    readonly changedFields: readonly string[];
    readonly rotatedFields: readonly string[];
  },
): Record<string, unknown> {
  return {
    enabledFrom: base.enabledFrom,
    enabledTo: base.enabledTo,
    changedFields: base.changedFields,
    rotatedFields: base.rotatedFields,
    ...(key === 'captcha.turnstile' && base.enabledFrom && !base.enabledTo
      ? { securityControlDisabled: true }
      : {}),
  };
}

/**
 * 明文视图合并：未知字段拒绝；值校验形状并拒 enc: 伪装密文；null = 清除；
 * 已有 secret 字段先解密（解密失败的存量密文保持原样——落库时原样回写不放大损坏）。
 */
function mergePlaintext(
  deps: UpdateIntegrationDeps,
  spec: ReturnType<typeof specOf>,
  views: {
    readonly stored: Readonly<Record<string, unknown>>;
    readonly submitted: Readonly<Record<string, string | null>>;
  },
): Record<string, string> {
  const { stored, submitted } = views;
  const merged: Record<string, string> = {};
  for (const field of spec.fields) {
    const value = stored[field.name];
    if (typeof value !== 'string' || value.length === 0) continue;
    merged[field.name] = field.secret ? (safeDecrypt(deps, value) ?? value) : value;
  }
  for (const [name, value] of Object.entries(submitted)) {
    const field = spec.fields.find((f) => f.name === name);
    if (field == null) {
      throw controlPlaneErrors.business('integration_field_invalid', {
        key: spec.key,
        field: name,
      });
    }
    if (value == null) {
      Reflect.deleteProperty(merged, name);
      continue;
    }
    if (value.startsWith(CIPHERTEXT_PREFIX)) {
      throw controlPlaneErrors.business('integration_secret_encrypted', {
        key: spec.key,
        field: name,
      });
    }
    if (!isValidFieldValue(field.kind, value)) {
      throw controlPlaneErrors.business('integration_field_invalid', {
        key: spec.key,
        field: name,
      });
    }
    merged[name] = value;
  }
  return merged;
}

/**
 * 轮换入窗（DESIGN §5 D6）：rotatable secret 字段值变更且旧值在场 → 旧密文进
 * previous_secrets 并刷新 rotatedAt。窗口只追踪最近一次轮换（多字段同轮变更共用时刻）。
 */
function rotateSecrets(
  deps: UpdateIntegrationDeps,
  spec: ReturnType<typeof specOf>,
  state: {
    readonly existing: IntegrationSettingsRow | undefined;
    readonly merged: Record<string, string>;
  },
): {
  previousSecrets: Record<string, string> | null;
  rotatedAt: Date | null;
  rotatedFields: readonly string[];
} {
  const { existing, merged } = state;
  const rotatedFields = spec.fields
    .filter((field) => field.rotatable && field.secret)
    .filter((field) => {
      const storedValue = existing?.config[field.name];
      if (typeof storedValue !== 'string' || storedValue.length === 0) return false;
      const storedPlain = safeDecrypt(deps, storedValue) ?? storedValue;
      return merged[field.name] != null && merged[field.name] !== storedPlain;
    })
    .map((field) => field.name);
  if (rotatedFields.length === 0 || existing == null) {
    return { previousSecrets: null, rotatedAt: null, rotatedFields };
  }
  const previousSecrets: Record<string, string> = {};
  for (const name of rotatedFields) {
    previousSecrets[name] = existing.config[name] as string;
  }
  return { previousSecrets, rotatedAt: deps.now(), rotatedFields };
}

/** 存储视图：secret 字段一次性加密（明文只在加密前内存存在——与渠道 Key 同纪律） */
function encryptSecrets(
  deps: UpdateIntegrationDeps,
  spec: ReturnType<typeof specOf>,
  merged: Record<string, string>,
): Record<string, string> {
  const stored: Record<string, string> = {};
  for (const field of spec.fields) {
    const value = merged[field.name];
    if (value == null) continue;
    stored[field.name] = field.secret ? deps.cipher.encrypt(value) : value;
  }
  return stored;
}

function safeDecrypt(deps: UpdateIntegrationDeps, packed: string): string | null {
  try {
    const decrypted = deps.cipher.decrypt(packed);
    return decrypted.length > 0 ? decrypted : null;
  } catch {
    return null;
  }
}
