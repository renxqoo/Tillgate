/**
 * 集成字段规格表（DESIGN §3.2）：同一真相驱动写入校验、掩码回显、完整性判定与导入分组。
 * secret = 加密落库（enc:v1 内嵌 config jsonb）；rotatable = 变更时旧值进双读窗
 * （仅支付验签字段——DESIGN §5 D6 收窄）；required = configured 完整性必填项。
 */
import { EPAY_PAY_TYPES } from '@tillgate/billing';

import { INTEGRATION_FIELD_MAX_LENGTH } from './keys';
import type { IntegrationKey } from './keys';

/** 字段值形状（校验器选择） */
export type IntegrationFieldKind = 'text' | 'url' | 'port' | 'payType';

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
const url = (name: string, flags: FieldFlags): IntegrationFieldSpec => field(name, 'url', flags);
const port = (name: string): IntegrationFieldSpec => field(name, 'port', { required: false });
const payType = (name: string): IntegrationFieldSpec => field(name, 'payType', { required: false });

export const INTEGRATION_SPECS: Readonly<Record<IntegrationKey, IntegrationSpec>> = {
  'oauth.base': spec('oauth.base', [
    url('frontendUrl', { required: true }),
    url('apiBase', { required: true }),
  ]),
  'oauth.github': spec('oauth.github', [
    text('clientId', { required: true }),
    text('clientSecret', { required: true, secret: true }),
  ]),
  'oauth.google': spec('oauth.google', [
    text('clientId', { required: true }),
    text('clientSecret', { required: true, secret: true }),
  ]),
  smtp: spec('smtp', [
    text('host', { required: true }),
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

/** 字段形状校验（纯函数；长度上限对所有 kind 生效） */
export function isValidFieldValue(kind: IntegrationFieldKind, value: string): boolean {
  if (value.length === 0 || value.length > INTEGRATION_FIELD_MAX_LENGTH) return false;
  switch (kind) {
    case 'text':
      return true;
    case 'url':
      return isValidHttpUrl(value);
    case 'port':
      return isValidPort(value);
    case 'payType':
      return (EPAY_PAY_TYPES as readonly string[]).includes(value);
  }
}

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidPort(value: string): boolean {
  if (!/^\d{1,5}$/.test(value)) return false;
  const portNumber = Number(value);
  return portNumber >= 1 && portNumber <= 65535;
}
