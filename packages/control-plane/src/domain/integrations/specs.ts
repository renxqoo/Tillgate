/**
 * 集成字段规格表：同一真相驱动写入校验、掩码回显、完整性判定与导入分组。
 * secret = 加密落库（enc:v1 内嵌 config jsonb）；rotatable = 变更时旧值进双读窗
 * （仅支付验签字段）；required = configured 完整性必填项。
 */
import { EPAY_PAY_TYPES } from '@tillgate/billing';

import { INTEGRATION_FIELD_MAX_LENGTH } from './keys';
import type { IntegrationKey } from './keys';

/** 字段值形状（校验器选择） */
export type IntegrationFieldKind = 'text' | 'url' | 'host' | 'port' | 'payType';

export interface IntegrationFieldSpec {
  readonly name: string;
  readonly required: boolean;
  readonly secret: boolean;
  readonly rotatable: boolean;
  readonly kind: IntegrationFieldKind;
}

export interface IntegrationSpec {
  readonly key: IntegrationKey;
  readonly fields: readonly IntegrationFieldSpec[];
}

/** 字段规格按 key 封闭登记（词表外键在 keys.ts 层已拦截） */
const spec = (key: IntegrationKey, fields: readonly IntegrationFieldSpec[]): IntegrationSpec => ({
  key,
  fields,
});

interface FieldFlags {
  readonly required: boolean;
  readonly secret?: boolean;
  readonly rotatable?: boolean;
}

const field = (
  name: string,
  kind: IntegrationFieldKind,
  flags: FieldFlags,
): IntegrationFieldSpec => ({
  name,
  kind,
  required: flags.required,
  secret: flags.secret ?? false,
  rotatable: flags.rotatable ?? false,
});

const text = (name: string, flags: FieldFlags): IntegrationFieldSpec => field(name, 'text', flags);
const host = (name: string, flags: FieldFlags): IntegrationFieldSpec => field(name, 'host', flags);
const url = (name: string, flags: FieldFlags): IntegrationFieldSpec => field(name, 'url', flags);
const port = (name: string): IntegrationFieldSpec => field(name, 'port', { required: false });
const payType = (name: string): IntegrationFieldSpec => field(name, 'payType', { required: false });

export const INTEGRATION_SPECS: Readonly<Record<IntegrationKey, IntegrationSpec>> = {
  'oauth.github': spec('oauth.github', [
    text('clientId', { required: true }),
    text('clientSecret', { required: true, secret: true }),
  ]),
  'oauth.google': spec('oauth.google', [
    text('clientId', { required: true }),
    text('clientSecret', { required: true, secret: true }),
  ]),
  smtp: spec('smtp', [
    host('host', { required: true }),
    port('port'),
    text('user', { required: true }),
    text('pass', { required: true, secret: true }),
    text('from', { required: false }),
  ]),
  'captcha.turnstile': spec('captcha.turnstile', [
    text('siteKey', { required: true }),
    text('secretKey', { required: true, secret: true }),
    url('verifyUrl', { required: false }),
  ]),
  'payment.epay': spec('payment.epay', [
    text('pid', { required: true }),
    text('key', { required: true, secret: true, rotatable: true }),
    url('gatewayUrl', { required: true }),
    url('notifyUrl', { required: true }),
    url('returnUrl', { required: true }),
    payType('payType'),
  ]),
  'payment.stripe': spec('payment.stripe', [
    text('secretKey', { required: true, secret: true }),
    text('webhookSecret', { required: true, secret: true, rotatable: true }),
    url('successUrl', { required: true }),
    url('cancelUrl', { required: true }),
    url('apiBase', { required: false }),
  ]),
};

export function specOf(key: IntegrationKey): IntegrationSpec {
  return INTEGRATION_SPECS[key];
}

/** 字段形状校验（纯函数；长度上限与空白串拒绝对所有 kind 生效） */
export function isValidFieldValue(kind: IntegrationFieldKind, value: string): boolean {
  if (value.length === 0 || value.length > INTEGRATION_FIELD_MAX_LENGTH) return false;
  if (value.trim().length === 0) return false; // 空白串 = 无效值
  switch (kind) {
    case 'text':
      return true;
    case 'url':
      return isValidHttpUrl(value);
    case 'host':
      return isValidSmtpHost(value);
    case 'port':
      return isValidPort(value);
    case 'payType':
      return (EPAY_PAY_TYPES as readonly string[]).includes(value);
  }
}

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    // SSRF 探测面收窄：拒绝回环/私网/链路本地字面量
    // （e2e/私有化经 store 直种绕过本层；DNS 级 rebinding 不在本层范围）
    return !isPrivateNetworkHost(parsed.hostname);
  } catch {
    return false;
  }
}

/** SMTP 主机形状：裸主机名/IP（允许私网内网中继——合法形态），拒绝 scheme/路径 */
function isValidSmtpHost(value: string): boolean {
  if (value.includes('://') || value.includes('/')) return false;
  if (value !== value.trim()) return false;
  return /^[A-Za-z0-9._:-]+$/.test(value);
}

function isPrivateNetworkHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1' || normalized === '0.0.0.0') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (v4 != null) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

function isValidPort(value: string): boolean {
  if (!/^\d{1,5}$/.test(value)) return false;
  const portNumber = Number(value);
  return portNumber >= 1 && portNumber <= 65535;
}
