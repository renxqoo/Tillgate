import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM 加解密（与 gateway/src/lib/crypto.ts 完全同逻辑同格式）。
 * 密钥来自 ENCRYPTION_KEY 环境变量（SHA-256 派生 32 字节）。
 *
 * 密文格式：enc:v1:<ivHex>:<tagHex>:<cipherHex>
 * 用于渠道上游 Key 落库加密（admin-api 加密写入，gateway 运行时解密使用）。
 */

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

function keyFromEnv(encryptionKey: string): Buffer {
  return createHash('sha256').update(encryptionKey).digest();
}

export function encrypt(plaintext: string, encryptionKey: string): string {
  const key = keyFromEnv(encryptionKey);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decrypt(packed: string, encryptionKey: string): string {
  const parts = packed.split(':');
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') {
    throw new Error('invalid ciphertext format');
  }
  const iv = Buffer.from(parts[2]!, 'hex');
  const tag = Buffer.from(parts[3]!, 'hex');
  const cipher = Buffer.from(parts[4]!, 'hex');
  const key = keyFromEnv(encryptionKey);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(cipher), decipher.final()]);
  return dec.toString('utf8');
}

/** 脱敏展示：返回 ag_****abcd 风格（仅末 4 位） */
export function maskKey(plaintext: string): string {
  if (plaintext.length <= 8) return '****';
  return plaintext.slice(0, 4) + '****' + plaintext.slice(-4);
}
