import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM 对称加解密（用于渠道上游 Key 落库加密）。
 * 密钥来自环境变量 ENCRYPTION_KEY（≥32 字符），取其 SHA-256 派生 32 字节 key。
 *
 * 密文格式：enc:v1:<ivHex>:<tagHex>:<cipherHex>
 *   - iv：12 字节随机（每次加密不同）
 *   - tag：16 字节 GCM 认证标签（防篡改）
 *   - cipher：密文 hex
 */

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

/** 从 ENCRYPTION_KEY 派生 32 字节 AES key（SHA-256） */
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
    throw new Error('invalid ciphertext format (expected enc:v1:iv:tag:cipher)');
  }
  const iv = Buffer.from(parts[2]!, 'hex');
  const tag = Buffer.from(parts[3]!, 'hex');
  const cipher = Buffer.from(parts[4]!, 'hex');
  if (iv.length !== IV_LEN) throw new Error('invalid iv length');
  if (tag.length !== TAG_LEN) throw new Error('invalid tag length');
  const key = keyFromEnv(encryptionKey);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(cipher), decipher.final()]);
  return dec.toString('utf8');
}
