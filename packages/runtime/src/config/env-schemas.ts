import { z } from 'zod';

/**
 * 环境变量校验原语（各 app 的 config schema 组装件）。
 * app 特有的 env 组合不进 runtime——这里只提供跨 app 复用的门。
 */

const KNOWN_WEAK_SECRETS = new Set([
  'change-me',
  'secret',
  'password',
  'changeme',
  'test-jwt-secret-min-16-chars',
  'test-encryption-key-32-chars-min!!',
  'change-me-32-chars-minimum-secret',
  'passwordpassword',
]);

/**
 * 密钥三道门：长度 ≥ minLen、非已知弱值、≥4 种不同字符。
 * 黑名单只是兜底（改一个字符即绕过，且测试专用值编入生产校验本身脆弱）——
 * 主防线是长度与字符多样性两道（IMPLEMENTATION.md §2.1 B3）。
 */
export function secretSchema(field: string, minLen: number) {
  return z
    .string()
    .min(minLen, `${field} must be at least ${minLen} characters long`)
    .refine((value) => !KNOWN_WEAK_SECRETS.has(value), {
      message: `${field} must not use a placeholder or weak secret (e.g. change-me-*, secret, password)`,
    })
    .refine((value) => new Set(value).size >= 4, {
      message: `${field} has too few distinct characters (at least 4 required)`,
    });
}

/** 环境变量布尔值只接受精确 true/false，也允许装配测试直接传 boolean。 */
export function strictBooleanSchema(defaultValue: boolean) {
  return z
    .union([z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true')])
    .default(defaultValue);
}
