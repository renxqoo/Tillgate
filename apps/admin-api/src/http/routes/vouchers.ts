/**
 * 凭证路由（P5;v1 routes/vouchers.ts 平移）：进货凭证截图回读 GET /v1/vouchers/:key。
 * 上传内联在 recharge 的 voucherDataUrl;本路由只做存储换读（键校验在 storage——
 * 防路径穿越;load 返回原始字节流,content-type 原样回放）。
 */
import { Hono } from 'hono';
import type { ControlPlane } from '@tillgate/control-plane';
import { AdminErrors } from '../error-face';
import type { SessionEnv } from '../middleware/session';

export interface VouchersRoutesDeps {
  readonly controlPlane: Pick<ControlPlane, 'channels'>;
}

export function vouchersRoutes(deps: VouchersRoutesDeps) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/vouchers/:key', async (c) => {
    const stored = await deps.controlPlane.channels.loadVoucher(c.req.param('key'));
    if (stored === null) {
      throw AdminErrors.business('voucher_not_found', {});
    }
    return new Response(stored.data, { headers: { 'content-type': stored.mimeType } });
  });

  return app;
}
