/**
 * 渠道进货凭证存储（DB 实现——多副本安全）。
 * 只服务进货凭证截图的回读：上传内联在 recharge 的 voucherDataUrl 里。
 * 键格式 `${uuid}.${ext}`；读取前键白名单校验（防注入/越权键）。
 * 背景：原本地磁盘实现（./data/vouchers）第二副本起互不可见、容器重建即丢——
 * 0066 迁移入 voucher_blobs（bytea，≤2MB 白名单小图，低频回看不引入对象存储）。
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '@ai-gateway/repository';
import { AppError } from '../http/error-map.js';

export interface VoucherStorage {
  /** 存凭证 → 键；MIME 白名单外的类型拒绝 */
  save(data: Buffer, mimeType: string): Promise<string>;
  /** 取凭证；键非法/不存在 → null */
  load(key: string): Promise<{ data: Buffer; mimeType: string } | null>;
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const EXT_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_EXT).map(([mime, ext]) => [ext, mime]),
);

const KEY_RE = /^[a-f0-9-]{36}\.[a-z0-9]{3,5}$/;

/** data:image/xxx;base64 载荷解析（格式/大小在服务层收口） */
export function parseVoucherDataUrl(
  dataUrl: string,
  maxBytes: number,
): { data: Buffer; mimeType: string } {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) {
    throw new AppError(400, 'invalid_voucher', '凭证必须是 image/png|jpeg|webp|gif 的 base64 data URL');
  }
  const data = Buffer.from(match[2]!, 'base64');
  if (data.length > maxBytes) {
    throw new AppError(400, 'voucher_too_large', `凭证截图超过 ${(maxBytes / 1024 / 1024).toFixed(1)}MB 上限`);
  }
  return { data, mimeType: match[1]! };
}

export function createDbVoucherStorage(db: Db): VoucherStorage {
  return {
    async save(data, mimeType) {
      const ext = MIME_EXT[mimeType];
      if (!ext) {
        throw new AppError(400, 'invalid_voucher', `不支持的凭证类型：${mimeType}`);
      }
      const key = `${randomUUID()}.${ext}`;
      await db.$client.query(
        'insert into voucher_blobs ("key", mime, "data") values ($1, $2, $3)',
        [key, mimeType, data],
      );
      return key;
    },
    async load(key) {
      if (!KEY_RE.test(key)) return null;
      const ext = key.split('.')[1]!;
      const mimeType = EXT_MIME[ext];
      if (!mimeType) return null;
      // 键与落库 MIME 双校验（防扩展名改写型伪造键）
      const r = await db.$client.query<{ mime: string; data: Buffer }>(
        'select mime, "data" from voucher_blobs where "key" = $1 and mime = $2',
        [key, mimeType],
      );
      const row = r.rows[0];
      return row ? { data: Buffer.from(row.data), mimeType: row.mime } : null;
    },
  };
}
