/**
 * TOTP 纯函数（RFC 4226 HOTP + RFC 6238 TOTP，HMAC-SHA1，零三方依赖）。
 * 输入输出全为明文内存值；存储加密（SecretCipher）在动词层完成，此处不知情。
 */
import { createHmac } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 编码（无填充） */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/** base32 解码（大小写不敏感，忽略填充 '='）；非法字符抛 Error */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) {
      throw new Error(`invalid base32 character '${char}'`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** RFC 4226 动态截断 → digits 位数字码（前导零保留） */
export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(counterBuf).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** epochMs 时刻的 TOTP 码 */
export function totpAt(secret: Buffer, epochMs: number, stepSec = 30, digits = 6): string {
  return hotp(secret, Math.floor(epochMs / 1000 / stepSec), digits);
}

/**
 * 在 [当前步 - windowStep, 当前步 + windowStep] 窗口内匹配 code，
 * 返回命中的步号（多步同时命中取最大步——步进单调 CAS 防重放的最强锚点）；未命中返回 null。
 */
export function matchingTotpStep(
  secret: Buffer,
  code: string,
  epochMs: number,
  stepSec = 30,
  windowStep = 1,
  digits = 6,
): number | null {
  if (typeof code !== 'string' || !/^[0-9]{1,10}$/.test(code)) return null;
  const current = Math.floor(epochMs / 1000 / stepSec);
  let matched: number | null = null;
  for (let step = current - windowStep; step <= current + windowStep; step += 1) {
    if (step >= 0 && hotp(secret, step, digits) === code) {
      matched = step;
    }
  }
  return matched;
}

/** 恢复码字母表：去易混字符（I/L/O/0/1），10 位，形如 7QK-B2M4-9XP 无分隔符 */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const RECOVERY_CODE_LENGTH = 10;

/** 生成恢复码明文（crypto 随机；消费方 confirmTotp 只展示这一次） */
export function generateRecoveryCode(random: (alphabetLen: number) => number): string {
  let code = '';
  for (let i = 0; i < RECOVERY_CODE_LENGTH; i += 1) {
    code += RECOVERY_ALPHABET[random(RECOVERY_ALPHABET.length)];
  }
  return code;
}
