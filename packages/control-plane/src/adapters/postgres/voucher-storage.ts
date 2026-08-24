/**
 * 渠道进货凭证存储 postgres 适配器（voucher_blobs bytea；v1 voucher-storage 等价迁移）。
 * voucher_blobs 是 raw-SQL 表（drizzle schema 两仓均未建模，DDL 在 db 迁移 0066）——
 * 经 drizzle sql 模板参数化执行，不引入表建模双轨。
 * 只服务凭证截图的回读：≤2MB 白名单小图 + 低频回看——不引入对象存储。
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '@tillgate/db';
import { controlPlaneErrors } from '../../errors';
import type { VoucherStorage } from '../../ports/voucher-storage';

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

export function createPostgresVoucherStorage(db: Db): VoucherStorage {
  return {
    async save(data, mimeType) {
      const ext = MIME_EXT[mimeType];
      if (!ext) {
        throw controlPlaneErrors.business('invalid_voucher', { mimeType });
      }
      const key = `${randomUUID()}.${ext}`;
      await db.execute(
        sql`insert into voucher_blobs ("key", mime, "data") values (${key}, ${mimeType}, ${data})`,
      );
      return key;
    },

    async load(key) {
      // 键白名单校验（防注入/越权键）
      if (!KEY_RE.test(key)) return null;
      const ext = key.split('.')[1]!;
      const mimeType = EXT_MIME[ext];
      if (!mimeType) return null;
      // 键与落库 MIME 双校验（防扩展名改写型伪造键）
      const result = await db.execute<{ mime: string; data: Uint8Array }>(
        sql`select mime, "data" from voucher_blobs where "key" = ${key} and mime = ${mimeType}`,
      );
      const row = result.rows[0];
      return row ? { data: Uint8Array.from(row.data), mimeType: row.mime } : null;
    },
  };
}
