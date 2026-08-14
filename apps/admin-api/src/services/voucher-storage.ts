import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 凭证存储抽象（渠道进货支付凭证截图）。
 *
 * 当前实现：本地磁盘。后续对接 OSS 时，新增 OssVoucherStorage 实现本接口，
 * save 上传到 OSS 返回 object key、load 从 OSS 读回，DB 存的是 key，无需改表。
 */

export interface StoredVoucher {
  data: Uint8Array;
  mimeType: string;
}

export interface VoucherStorage {
  /** 保存凭证字节，返回存储 key（DB 只存 key） */
  save(data: Uint8Array, mimeType: string): Promise<string>;
  /** 按 key 读回凭证；不存在/非法 key 返回 null */
  load(key: string): Promise<StoredVoucher | null>;
}

/** 支持的图片类型 → 文件扩展名 */
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** 严格校验 key（防路径穿越 + 非法格式），非法返回 null */
function safeKey(key: string): string | null {
  return /^[a-f0-9-]{36}\.[a-z0-9]{3,5}$/.test(key) ? key : null;
}

/** 本地磁盘实现（key = `${uuid}.${ext}`，文件名白名单防穿越） */
export function createLocalVoucherStorage(dir: string): VoucherStorage {
  const root = dir;
  return {
    async save(data: Uint8Array, mimeType: string): Promise<string> {
      const ext = MIME_EXT[mimeType];
      if (!ext) throw new Error(`unsupported voucher mime type: ${mimeType}`);
      const key = `${randomUUID()}.${ext}`;
      await mkdir(root, { recursive: true });
      await writeFile(join(root, key), data);
      return key;
    },
    async load(key: string): Promise<StoredVoucher | null> {
      const name = safeKey(key);
      if (!name) return null;
      const ext = name.split('.').pop()!;
      const mimeType = Object.entries(MIME_EXT).find(([, e]) => e === ext)?.[0];
      if (!mimeType) return null;
      try {
        const data = await readFile(join(root, name));
        return { data: new Uint8Array(data), mimeType };
      } catch {
        return null;
      }
    },
  };
}
