/**
 * 账号凭证材料生成(v1 http/secrets.ts 的 api-key/app 部分**随消费者迁入**,D3/C5;
 * http 同一变更删除对应导出)。纯函数 + node:crypto 随机源,无其他 I/O。
 *
 * 安全设计(与 v1 一致):明文只在生成时返回一次;落库只存 SHA-256;鉴权端对明文
 * 再哈希后等值查。Key 前缀是部署可变值(与网关分派端同一 env),**必填注入**(B5)。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';

/** Key 前缀合法性:^[a-z][a-z0-9_-]{1,15}$(与 v1 gateway/client-api 共用 env 约束) */
export const KEY_PREFIX_RE = /^[a-z][a-z0-9_-]{1,15}$/;

export function isValidKeyPrefix(prefix: string): boolean {
  return KEY_PREFIX_RE.test(prefix);
}

/** SHA-256 → 64 位小写 hex */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export interface KeyMaterial {
  /** 明文:仅在创建/轮换返回值中出现,永不落库 */
  readonly plaintext: string;
  /** SHA-256(明文),唯一索引列 */
  readonly keyHash: string;
  /** 脱敏预览:前 3 + **** + 末 4 */
  readonly keyPreview: string;
}

/** 生成虚拟 Key 材料:<prefix><40 hex>(160 bit 熵) */
export function generateKeyMaterial(prefix: string): KeyMaterial {
  const plaintext = prefix + randomBytes(20).toString('hex');
  return { plaintext, keyHash: sha256Hex(plaintext), keyPreview: maskKey(plaintext) };
}

/** Key 脱敏预览(v1 maskKey;长度 ≤8 全遮) */
export function maskKey(plaintext: string): string {
  if (plaintext.length <= 8) return '****';
  return `${plaintext.slice(0, 3)}****${plaintext.slice(-4)}`;
}

export interface AppCredentials {
  /** 对外公共应用标识:32 hex(DDL varchar(32) 契约) */
  readonly appId: string;
  /** OAuth client_id:app_ + 16 hex */
  readonly clientId: string;
  /** client_secret 明文:48 hex,仅下发一次 */
  readonly clientSecret: string;
  /** SHA-256(client_secret) */
  readonly clientSecretHash: string;
}

/** 生成 Application 凭证材料(v1 形态:uuid 去杠截 32 / app_+16hex / 24 字节 hex) */
export function generateAppCredentials(): AppCredentials {
  const clientSecret = randomBytes(24).toString('hex');
  return {
    appId: randomUUID().replace(/-/g, '').slice(0, 32),
    clientId: `app_${randomBytes(8).toString('hex')}`,
    clientSecret,
    clientSecretHash: sha256Hex(clientSecret),
  };
}
