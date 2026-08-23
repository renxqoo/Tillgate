/**
 * 统一挑战纯函数层:码哈希(HMAC-SHA256 pepper,B13)、码生成、参数覆盖界、payload 界、
 * 投递通道映射。一个抽象多种业务(登录码/注册验证/找回),机制对所有 kind 通用。
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
 * pepper 为服务端密钥(装配注入)——6 位码空间仅 10^6,v1 无 pepper 的裸 sha256
 * 在库泄露后可秒级离线枚举(B13);challengeId 即盐,同码不同行哈希不同。
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

function invalid(field: string, min: number, max: number, value: number | undefined) {
  return identityErrors.business('invalid_input', {
    field,
    reason: `must be an integer in [${min}, ${max}], got ${String(value)}`,
  });
}

/** 覆盖参数界(v1 语义):值未给用缺省;给了必须整数且在界内 */
export function boundedOverride(
  value: number | undefined,
  fallback: number,
  field: string,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw invalid(field, min, max, value);
  }
  return value;
}

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

/** 恢复码哈希:HMAC-SHA256(pepper, code)——与挑战码同一 pepper 口径(B13) */
export function recoveryCodeHashOf(code: string, pepper: string): string {
  return createHmac('sha256', pepper).update(code).digest('hex');
}
