import { Hono } from 'hono';
import { HttpError } from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import type { AdminServices } from '../services/index.js';

/**
 * 凭证截图静态服务（管理端鉴权后访问）。
 *
 *   - GET /:key：按 key 读回凭证字节（本地磁盘 / 未来 OSS）
 * key 由 VoucherStorage 白名单校验，杜绝路径穿越。
 */
export function voucherRoutes(s: AdminServices): Hono<AdminEnv> {
  return new Hono<AdminEnv>().get('/:key', async (c) => {
    const key = c.req.param('key');
    const stored = await s.voucherStorage.load(key);
    if (!stored) throw new HttpError('VOUCHER_NOT_FOUND');
    return new Response(stored.data, { headers: { 'content-type': stored.mimeType } });
  });
}
