import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM 对称加解密工厂（渠道上游 Key 落库加密）。
 * 密钥由装配方提供（如 ENCRYPTION_KEY ≥32 字符），装配一次派生一次（SHA-256 → 32 字节 key）。
 *
 * 密文格式：enc:v1:<ivHex>:<tagHex>:<cipherHex>——与 v1 存量落库行逐字节兼容（同密钥互解）。
 * v1 是格式标记，非密钥世代（单 key 单格式）：
 *   - iv：12 字节随机（每次加密不同）
 *   - tag：16 字节 GCM 认证标签（防篡改）
 *   - cipher：密文 hex
 */

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

export interface Cipher {
  encrypt(plaintext: string): string;
  decrypt(packed: string): string;
}

export function createCipher(encryptionKey: string): Cipher {
  const key = createHash('sha256').update(encryptionKey).digest();
  return {
    encrypt(plaintext: string): string {
      const iv = randomBytes(IV_LEN);
      const cipher = createCipheriv(ALGO, key, iv);
      const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `enc:v1:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
    },

    decrypt(packed: string): string {
      const parts = packed.split(':');
      if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') {
        throw new Error('invalid ciphertext format (expected enc:v1:iv:tag:cipher)');
      }
      const iv = Buffer.from(parts[2]!, 'hex');
      const tag = Buffer.from(parts[3]!, 'hex');
      const cipherBody = Buffer.from(parts[4]!, 'hex');
      if (iv.length !== IV_LEN) throw new Error('invalid iv length');
      if (tag.length !== TAG_LEN) throw new Error('invalid tag length');
      const decipher = createDecipheriv(ALGO, key, iv);
      decipher.setAuthTag(tag);
      const dec = Buffer.concat([decipher.update(cipherBody), decipher.final()]);
      return dec.toString('utf8');
    },
  };
}
