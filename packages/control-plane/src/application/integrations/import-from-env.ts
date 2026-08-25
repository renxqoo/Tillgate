/**
 * env → integration_settings 一次性导入（DESIGN §7.2）：
 * 计划纯函数（可测）+ 应用函数（幂等：已存在的键跳过，不覆盖 admin 已改值）。
 * 语义对齐存量启动校验：完整组导入并启用；非空不完整组跳过并警告（不部分导入）。
 */
import { isValidFieldValue, specOf } from '../../domain/integrations/specs';
import { INTEGRATION_KEYS } from '../../domain/integrations/keys';
import type { IntegrationKey } from '../../domain/integrations/keys';
import type { Db } from '@tillgate/db';
import type { AuditSink } from '../../ports/audit-sink';
import type { SecretCipher } from '../../ports/secret-cipher';
import type { IntegrationSettingsStore } from '../../ports/integration-settings-store';
import { emitAudit } from '../audit';

/** env 变量名 → 字段名映射（导入一次性事实，不进 domain 词表） */
const ENV_FIELDS: Readonly<Record<IntegrationKey, Readonly<Record<string, string>>>> = {
  'oauth.base': { frontendUrl: 'OAUTH_FRONTEND_URL', apiBase: 'OAUTH_API_BASE' },
  'oauth.github': {
    clientId: 'OAUTH_GITHUB_CLIENT_ID',
    clientSecret: 'OAUTH_GITHUB_CLIENT_SECRET',
  },
  'oauth.google': {
    clientId: 'OAUTH_GOOGLE_CLIENT_ID',
    clientSecret: 'OAUTH_GOOGLE_CLIENT_SECRET',
  },
  smtp: {
    host: 'SMTP_HOST',
    port: 'SMTP_PORT',
    user: 'SMTP_USER',
    pass: 'SMTP_PASS',
    from: 'SMTP_FROM',
  },
  'captcha.turnstile': {
    siteKey: 'CAPTCHA_SITE_KEY',
    secretKey: 'CAPTCHA_SECRET_KEY',
    verifyUrl: 'CAPTCHA_VERIFY_URL',
  },
  'payment.epay': {
    pid: 'EPAY_PID',
    key: 'EPAY_KEY',
    gatewayUrl: 'EPAY_GATEWAY_URL',
    notifyUrl: 'EPAY_NOTIFY_URL',
    returnUrl: 'EPAY_RETURN_URL',
    payType: 'EPAY_PAY_TYPE',
  },
  'payment.stripe': {
    secretKey: 'STRIPE_SECRET_KEY',
    webhookSecret: 'STRIPE_WEBHOOK_SECRET',
    successUrl: 'STRIPE_SUCCESS_URL',
    cancelUrl: 'STRIPE_CANCEL_URL',
    apiBase: 'STRIPE_API_BASE',
  },
};

export interface IntegrationImportRow {
  readonly key: IntegrationKey;
  readonly config: Readonly<Record<string, string>>;
}

export interface IntegrationImportSkip {
  readonly key: IntegrationKey;
  readonly present: readonly string[];
  readonly missing: readonly string[];
  /** 值形状非法的字段（对齐原 env zod 校验——垃圾值不导入） */
  readonly invalid: readonly string[];
}

export interface IntegrationImportPlan {
  readonly imports: readonly IntegrationImportRow[];
  readonly skipped: readonly IntegrationImportSkip[];
  readonly absent: readonly IntegrationKey[];
}

/** 纯规划：按词表逐组判定导入/跳过/未配置（env 值原样，不在此校验形状） */
export function planIntegrationImport(
  env: Readonly<Record<string, string | undefined>>,
): IntegrationImportPlan {
  const imports: IntegrationImportRow[] = [];
  const skipped: IntegrationImportSkip[] = [];
  const absent: IntegrationKey[] = [];
  for (const key of INTEGRATION_KEYS) {
    const spec = specOf(key);
    const config: Record<string, string> = {};
    const present: string[] = [];
    const missing: string[] = [];
    const invalid: string[] = [];
    for (const field of spec.fields) {
      const envName = ENV_FIELDS[key][field.name] ?? '';
      const value = env[envName];
      if (value != null && value.length > 0) {
        if (!isValidFieldValue(field.kind, value)) {
          invalid.push(field.name);
          continue;
        }
        config[field.name] = value;
        present.push(field.name);
      } else if (field.required) {
        missing.push(field.name);
      }
    }
    if (invalid.length > 0) skipped.push({ key, present, missing, invalid });
    else if (missing.length === 0 && present.length > 0) imports.push({ key, config });
    else if (missing.length > 0 && present.length > 0)
      skipped.push({ key, present, missing, invalid });
    else absent.push(key);
  }
  return { imports, skipped, absent };
}

export interface ApplyIntegrationImportDeps {
  readonly db: Db;
  readonly stores: { readonly integrationSettings: IntegrationSettingsStore };
  readonly cipher: SecretCipher;
  readonly audit?: AuditSink;
  readonly now: () => Date;
}

export interface IntegrationImportReport {
  readonly imported: readonly IntegrationKey[];
  readonly skippedExisting: readonly IntegrationKey[];
}

/** 应用：insert-if-absent（逐行原子——review 修复 A-4），secret 加密落库，逐键审计 */
export async function applyIntegrationImport(
  deps: ApplyIntegrationImportDeps,
  plan: IntegrationImportPlan,
): Promise<IntegrationImportReport> {
  const imported: IntegrationKey[] = [];
  const skippedExisting: IntegrationKey[] = [];
  for (const row of plan.imports) {
    const spec = specOf(row.key);
    const config: Record<string, string> = {};
    for (const field of spec.fields) {
      const value = row.config[field.name];
      if (value == null) continue;
      config[field.name] = field.secret ? deps.cipher.encrypt(value) : value;
    }
    // 逐行原子判存插入（readAll 快照只作报告，不再作唯一判据——间隙并发写不被覆盖）
    const inserted = await deps.stores.integrationSettings.insertIfAbsent(deps.db, {
      key: row.key,
      enabled: true,
      config,
      previousSecrets: null,
      rotatedAt: null,
      adminId: null,
    });
    if (inserted) {
      imported.push(row.key);
    } else {
      skippedExisting.push(row.key);
    }
  }
  // 逐键一条审计事件（review 修复 E-1：targetId ≤ audit_logs.target_id varchar(64)）
  for (const key of imported) {
    await emitAudit(deps.audit ?? neverAudit, {
      actor: 'system',
      action: 'settings.integrations.import',
      targetType: 'integration_setting',
      targetId: key,
      detail: { imported: [key] },
    });
  }
  return { imported, skippedExisting };
}

/** 无审计出口时的显式丢弃桩（导入为一次性迁移动作，缺审计出口不阻断） */
const neverAudit: AuditSink = {
  async record(): Promise<void> {
    // 显式 no-op：调用方未注入审计出口（脚本独立运行场景）
  },
};
