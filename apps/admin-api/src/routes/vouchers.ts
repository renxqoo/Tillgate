/**
 * 凭证路由（会话）：进货凭证截图回读（GET /v1/vouchers/:key）。
 * 上传内联在 recharge 的 voucherDataUrl；本路由只做存储换读。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { adminCtxOf } from './ctx.js';
import { AppError } from '../http/error-map.js';
import type { VoucherStorage } from '../services/voucher-storage.js';
import type { SessionEnv } from '../middleware/session.js';

export function vouchersRoutes(storage: VoucherStorage, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/vouchers/:key', session, async (c) => {
    // 键校验在 storage（防路径穿越）；ctx 仅保持链路一致
    void adminCtxOf(c);
    const stored = await storage.load(c.req.param('key'));
    if (!stored) {
      throw new AppError(404, 'voucher_not_found', '凭证不存在');
    }
    return new Response(stored.data, { headers: { 'content-type': stored.mimeType } });
  });

  return app;
}
