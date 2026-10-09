/**
 * 统一挑战纯函数层:码哈希(HMAC-SHA256 pepper)、码生成、参数覆盖界、payload 界、
 * 投递通道映射、投递失败诊断投影。一个抽象多种业务(登录码/注册验证/找回),
 * 机制对所有 kind 通用。
 */
import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { identityErrors } from './errors.js';
import type { IdentifierKind } from './identifier.js';

export type DeliveryChannel = 'email' | 'sms';

export type ChallengeTarget =
  | { readonly identifier: { readonly kind: string; readonly value: string } }
  | { readonly userId: number };

/** 内置投递通道映射:email→email;phone→sms(短信通道未实现,begin 时 fail-closed);username 无通道 */
export function channelFor(kind: IdentifierKind): DeliveryChannel | null {
  if (kind === 'email') return 'email';
  if (kind === 'phone') return 'sms';
  return null;
}

/**
 * 码哈希:HMAC-SHA256(pepper, `${code}:${challengeId}`)。
 * pepper 为服务端密钥(装配注入)——6 位码空间仅 10^6,无 pepper 的裸 sha256
 * 在库泄露后可秒级离线枚举;challengeId 即盐,同码不同行哈希不同。
 */
export function codeHashOf(code: string, challengeId: string, pepper: string): string {
  return createHmac('sha256', pepper).update(`${code}:${challengeId}`).digest('hex');
}

/** 随机数字码(crypto.randomInt,前导零保留) */
export function randomCode(digits: number): string {
  return String(randomInt(0, 10 ** digits)).padStart(digits, '0');
}

export function newChallengeId(): string {
  return randomUUID();
}

function invalid(field: string, bounds: { min: number; max: number }, value: number | undefined) {
  return identityErrors.business('invalid_input', {
    field,
    reason: `must be an integer in [${bounds.min}, ${bounds.max}], got ${String(value)}`,
  });
}

/** 覆盖参数界:值未给用缺省;给了必须整数且在界内 */
// eslint-disable-next-line max-params -- 覆盖语义五要素(值/缺省/字段名/上下界)各有其位,导出 API 且测试规格以位置参数锁定,改 options 放大 diff
export function boundedOverride(
  value: number | undefined,
  fallback: number,
  field: string,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw invalid(field, { min, max }, value);
  }
  return value;
}

/**
 * 投递异常诊断投影:投递失败对外统一收敛为 delivery_failed(不泄露通道细节),
 * 但根因必须可运维排查——ETIMEDOUT(出网不可达)/EAUTH(凭据被拒)/
 * 550(EENVELOPE,发件方被拒)三类的处置完全不同,只看 502 无法区分。
 *
 * 白名单逐字段取而非整包 dump:投递适配器的异常对象可能携带 auth 配置,
 * 整包记录即等于把凭据写进日志。未知异常对象只回 message。
 */
export function deliveryErrorDetail(error: unknown): Record<string, unknown> {
  if (typeof error !== 'object' || error == null) return { message: String(error) };
  const src = error as Record<string, unknown>;
  const detail: Record<string, unknown> = {};
  for (const field of DELIVERY_ERROR_FIELDS) {
    const value = src[field];
    // 逐字段收窄为 string|number:异常对象由外部适配器构造,不得带对象/函数进日志
    if (typeof value === 'string' || typeof value === 'number') detail[field] = value;
  }
  return detail;
}

/** 诊断投影白名单:传输层根因字段(不含任何凭据/信封收件人字段) */
const DELIVERY_ERROR_FIELDS = ['code', 'responseCode', 'command', 'message'] as const;

export const CHALLENGE_BOUNDS = {
  ttlMs: [1_000, 86_400_000],
  cooldownMs: [0, 3_600_000],
  maxAttempts: [1, 100],
} as const;

const MAX_PAYLOAD_BYTES = 4096;

/** payload 序列化界:≤4KB 且 JSON 可序列化 */
export function serializePayload(
  payload: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (payload == null) return null;
  let json: string;
  try {
    json = JSON.stringify(payload);
  } catch {
    throw identityErrors.business('invalid_input', {
      field: 'payload',
      reason: 'must be JSON-serializable',
    });
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw identityErrors.business('invalid_input', {
      field: 'payload',
      reason: `serialized size must be <= ${MAX_PAYLOAD_BYTES} bytes`,
    });
  }
  return payload;
}

/** 恢复码哈希:HMAC-SHA256(pepper, code)——与挑战码同一 pepper 口径 */
export function recoveryCodeHashOf(code: string, pepper: string): string {
  return createHmac('sha256', pepper).update(code).digest('hex');
}
