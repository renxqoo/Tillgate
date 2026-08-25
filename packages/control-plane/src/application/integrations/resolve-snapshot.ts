/**
 * 行集 → 运行时快照（DESIGN §5 D4）：解密 secret、按完整性/开关归一为消费面形状。
 * 纯依赖注入（cipher/now），reader 与测试共用；掩码管理面（list）不走这里。
 *
 * 语义要点：
 * - config 在 configured（必填齐全）时非 null——**与 enabled 无关**（支付「停用不停
 *   验签」：回调面按 config 工作，下单面按 effective 工作，DESIGN §5 D6）；
 * - effective = enabled && configured（OAuth provider 额外要求 oauth.base 生效）；
 * - required 字段解密失败 → 整行 config 降级 null（单字段脏值不外泄半成品凭据）。
 */
import { withinRotationWindow } from '../../domain/integrations/rotation';
import { isConfigComplete } from '../../domain/integrations/completeness';
import { specOf } from '../../domain/integrations/specs';
import type { IntegrationKey } from '../../domain/integrations/keys';
import type { SecretCipher } from '../../ports/secret-cipher';
import type { IntegrationSettingsRow } from '../../ports/integration-settings-store';
import type {
  CaptchaConfig,
  EpayConfig,
  IntegrationSnapshot,
  OauthProviderConfig,
  ResolvedIntegration,
  SmtpConfig,
  StripeConfig,
} from './snapshot-types';

interface ResolveDeps {
  readonly cipher: SecretCipher;
  readonly rows: readonly IntegrationSettingsRow[];
  readonly nowMs: number;
}

/** SMTP 缺省端口（隐式 TLS；与存量 env 口径一致） */
const SMTP_DEFAULT_PORT = 465;
/** 易支付缺省支付类型（与存量 env EPAY_PAY_TYPE 缺省一致；词表真源 = billing） */
const EPAY_DEFAULT_PAY_TYPE = 'alipay';

export function resolveIntegrationSnapshot(deps: ResolveDeps): IntegrationSnapshot {
  const byKey = new Map<IntegrationKey, IntegrationSettingsRow>(deps.rows.map((r) => [r.key, r]));
  const rowOf = (key: IntegrationKey): IntegrationSettingsRow => byKey.get(key) ?? emptyRow(key);

  return {
    oauth: {
      github: resolveOauth(rowOf('oauth.github'), deps),
      google: resolveOauth(rowOf('oauth.google'), deps),
    },
    smtp: resolveSmtp(rowOf('smtp'), deps),
    captcha: resolveCaptcha(rowOf('captcha.turnstile'), deps),
    payments: {
      epay: resolveEpay(rowOf('payment.epay'), deps),
      stripe: resolveStripe(rowOf('payment.stripe'), deps),
    },
  };
}

function emptyRow(key: IntegrationKey): IntegrationSettingsRow {
  return {
    key,
    enabled: false,
    config: {},
    previousSecrets: null,
    rotatedAt: null,
    updatedByAdminId: null,
    updatedAt: new Date(0),
  };
}

/** 行读取器：规格感知取值——secret 字段解密（失败归 null，degrade 整行兜底），非 secret 明文直读 */
function rowReader(
  deps: ResolveDeps,
  key: IntegrationKey,
  config: Readonly<Record<string, unknown>>,
): (field: string) => string | null {
  return (field) => {
    const raw = config[field];
    if (typeof raw !== 'string' || raw.length === 0) return null;
    const spec = specOf(key).fields.find((f) => f.name === field);
    if (spec == null || !spec.secret) return raw;
    return safeDecrypt(deps, raw);
  };
}

function safeDecrypt(deps: ResolveDeps, packed: string): string | null {
  try {
    const decrypted = deps.cipher.decrypt(packed);
    return decrypted.length > 0 ? decrypted : null;
  } catch {
    return null;
  }
}

/** required 解密失败降级：对象内任一 null 值 → 整行不可用（undefined 可选字段放行） */
function degrade<T extends object>(config: T | null): T | null {
  if (config == null) return null;
  return Object.values(config).some((v) => v === null) ? null : config;
}

function resolveOauth(
  row: IntegrationSettingsRow,
  deps: ResolveDeps,
): ResolvedIntegration<OauthProviderConfig> {
  const complete = isConfigComplete(specOf(row.key), row.config);
  const read = rowReader(deps, row.key, row.config);
  const config = degrade(
    complete
      ? {
          clientId: read('clientId') as string,
          clientSecret: read('clientSecret') as string,
        }
      : null,
  );
  return {
    configured: complete,
    enabled: row.enabled,
    effective: complete && row.enabled && config != null,
    config,
  };
}

function resolveSmtp(
  row: IntegrationSettingsRow,
  deps: ResolveDeps,
): ResolvedIntegration<SmtpConfig> {
  const complete = isConfigComplete(specOf('smtp'), row.config);
  const read = rowReader(deps, 'smtp', row.config);
  const config = degrade(
    complete
      ? {
          host: read('host') as string,
          port: portOf(row.config),
          user: read('user') as string,
          pass: read('pass') as string,
          from: optionalPlain(row.config['from']) ?? (read('user') as string),
        }
      : null,
  );
  return {
    configured: complete,
    enabled: row.enabled,
    effective: complete && row.enabled && config != null,
    config,
  };
}

function resolveCaptcha(
  row: IntegrationSettingsRow,
  deps: ResolveDeps,
): ResolvedIntegration<CaptchaConfig> {
  const complete = isConfigComplete(specOf('captcha.turnstile'), row.config);
  const read = rowReader(deps, 'captcha.turnstile', row.config);
  const config = degrade(
    complete
      ? {
          siteKey: read('siteKey') as string,
          secretKey: read('secretKey') as string,
          verifyUrl: optionalPlain(row.config['verifyUrl']),
        }
      : null,
  );
  return {
    configured: complete,
    enabled: row.enabled,
    effective: complete && row.enabled && config != null,
    config,
  };
}

function resolveEpay(
  row: IntegrationSettingsRow,
  deps: ResolveDeps,
): ResolvedIntegration<EpayConfig> {
  const complete = isConfigComplete(specOf('payment.epay'), row.config);
  const read = rowReader(deps, 'payment.epay', row.config);
  const key = read('key');
  const config = degrade(
    complete && key != null
      ? {
          pid: read('pid') as string,
          key,
          gatewayUrl: read('gatewayUrl') as string,
          notifyUrl: read('notifyUrl') as string,
          returnUrl: read('returnUrl') as string,
          payType: optionalPlain(row.config['payType']) ?? EPAY_DEFAULT_PAY_TYPE,
          verifyKeys: verifyKeysOf(deps, row, { field: 'key', current: key }),
        }
      : null,
  );
  return {
    configured: complete,
    enabled: row.enabled,
    effective: complete && row.enabled && config != null,
    config,
  };
}

function resolveStripe(
  row: IntegrationSettingsRow,
  deps: ResolveDeps,
): ResolvedIntegration<StripeConfig> {
  const complete = isConfigComplete(specOf('payment.stripe'), row.config);
  const read = rowReader(deps, 'payment.stripe', row.config);
  const webhookSecret = read('webhookSecret');
  const config = degrade(
    complete && webhookSecret != null
      ? {
          secretKey: read('secretKey') as string,
          webhookSecret,
          successUrl: read('successUrl') as string,
          cancelUrl: read('cancelUrl') as string,
          apiBase: optionalPlain(row.config['apiBase']),
          webhookSecrets: verifyKeysOf(deps, row, {
            field: 'webhookSecret',
            current: webhookSecret,
          }),
        }
      : null,
  );
  return {
    configured: complete,
    enabled: row.enabled,
    effective: complete && row.enabled && config != null,
    config,
  };
}

/** 双读窗密钥序列：[当前, 窗口内旧值]（DESIGN §5 D6——先新后旧） */
function verifyKeysOf(
  deps: ResolveDeps,
  row: IntegrationSettingsRow,
  target: { readonly field: string; readonly current: string },
): readonly string[] {
  const { field, current } = target;
  if (!withinRotationWindow(row.rotatedAt, deps.nowMs)) return [current];
  const previousEnc = row.previousSecrets?.[field];
  if (typeof previousEnc !== 'string' || previousEnc.length === 0) return [current];
  const previous = safeDecrypt(deps, previousEnc);
  return previous != null ? [current, previous] : [current];
}

function portOf(config: Readonly<Record<string, unknown>>): number {
  const raw = config['port'];
  if (typeof raw === 'string' && /^\d{1,5}$/.test(raw)) {
    const parsed = Number(raw);
    if (parsed >= 1 && parsed <= 65535) return parsed;
  }
  return SMTP_DEFAULT_PORT;
}

function optionalPlain(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
