/**
 * 集成字段掩码（DESIGN §4.1）：secret 回显只出「**** + 尾 4」形态，短值全遮。
 * 响应永不包含明文或密文——掩码对象是 GET 面的唯一回显形状。
 */
import type { IntegrationSpec } from './specs';

/** 掩码形态：长度 ≤ 8 全遮；否则保留尾 4（与通知渠道域 maskSecret 同口径） */
export function maskSecret(value: string): string {
  if (value.length <= 8) return '****';
  return `****${value.slice(-4)}`;
}

/**
 * 规格驱动的整行掩码：非 secret 字段原样，secret 字段掩码（未设置 = null；
 * 形状异常的存量值防御性归 null——掩码面永不抛错）。
 * maskSecretOf 收到的是解密后的明文（调用方负责解密；解密失败时传 null）。
 */
export function maskIntegrationConfig(
  spec: IntegrationSpec,
  config: Readonly<Record<string, unknown>>,
  decrypt: (field: string, value: string) => string | null,
): Record<string, string | null> {
  const masked: Record<string, string | null> = {};
  for (const field of spec.fields) {
    const value = config[field.name];
    if (typeof value !== 'string' || value.length === 0) {
      masked[field.name] = null;
      continue;
    }
    masked[field.name] = field.secret ? maskOf(value, field.name, decrypt) : value;
  }
  return masked;
}

function maskOf(
  value: string,
  field: string,
  decrypt: (field: string, value: string) => string | null,
): string {
  const plaintext = decrypt(field, value);
  return plaintext == null ? '****' : maskSecret(plaintext);
}
