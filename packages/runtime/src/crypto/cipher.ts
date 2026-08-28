import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { DefectError } from '@tillgate/errors';

/**
 * AES-256-GCM 对称加解密工厂（渠道上游 Key 落库加密）。
 * 密钥由装配方提供（如 ENCRYPTION_KEY ≥32 字符），装配一次派生一次（SHA-256 → 32 字节 key）。
 *
 * 密文格式：enc:v1:<ivHex>:<tagHex>:<cipherHex>——存量落库行同格式（同密钥互解）。
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

/** 密文五段的解包结果（enc:v1:ivHex:tagHex:cipherHex） */
interface PackedCiphertext {
  ivHex: string;
  tagHex: string;
  cipherHex: string;
}

// 模块级：密文格式解析与五段形状校验（与 encrypt 的打包格式单一真相对齐）。
// 解构默认 '' 仅在段缺失时生效——形状校验（恰好 5 段）通过后不会走到默认值，行为等价。
function parsePackedCiphertext(packed: string): PackedCiphertext {
  const parts = packed.split(':');
  const [prefix, version, ivHex = '', tagHex = '', cipherHex = ''] = parts;
  if (parts.length !== 5 || prefix !== 'enc' || version !== 'v1') {
    throw new DefectError(
      'invalid ciphertext format (expected enc:v1:iv:tag:cipher)',
      'runtime.cipher.invalid_format',
    );
  }
  return { ivHex, tagHex, cipherHex };
}

export function createCipher(encryptionKey: string): Cipher {
  // 空密钥 fail-fast：SHA-256 会把空串安静派生成合法 key——配置缺陷不得静默通过
  if (encryptionKey.length === 0) {
    throw new DefectError(
      'encryption key must not be empty (check ENCRYPTION_KEY)',
      'runtime.cipher.empty_key',
    );
  }
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
      const { ivHex, tagHex, cipherHex } = parsePackedCiphertext(packed);
      const iv = Buffer.from(ivHex, 'hex');
      const tag = Buffer.from(tagHex, 'hex');
      const cipherBody = Buffer.from(cipherHex, 'hex');
      if (iv.length !== IV_LEN || tag.length !== TAG_LEN) {
        throw new DefectError(
          'invalid ciphertext format (iv/tag length mismatch)',
          'runtime.cipher.invalid_format',
        );
      }
      const decipher = createDecipheriv(ALGO, key, iv);
      decipher.setAuthTag(tag);
      try {
        const dec = Buffer.concat([decipher.update(cipherBody), decipher.final()]);
        return dec.toString('utf8');
      } catch (error) {
        // GCM 认证失败：密钥错误或密文被篡改——缺陷语义（数据不变量破坏），保留原生 cause
        throw new DefectError(
          'ciphertext authentication failed (wrong key or tampered data)',
          'runtime.cipher.auth_failed',
          undefined,
          { cause: error },
        );
      }
    },
  };
}
