import { Hono } from 'hono';
import { and, desc, eq, sql } from 'drizzle-orm';
import { admins, channelRecharges, channels } from '@ai-gateway/db/schema';
import { z } from 'zod';
import { jsonBody, limitOffset, paginateQuery, paginationQuerySchema, parsePagination, query, recordAudit } from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import type { AdminServices } from '../services/index.js';
import { adjustChannel, rechargeChannel } from '../services/channel-funds.js';

/**
 * 渠道资金（入货 / 调账）—— 可追溯的进货额度管理。
 *
 *   - GET /：流水列表（入货+调账，关联渠道名与操作管理员，分页 + channelId/type 筛选）
 *   - POST /recharge：入货（金额>0，可附支付订单号 + 凭证截图 base64）
 *   - POST /adjust：调账（金额可正负，不可把额度调负）
 */

const rechargeSchema = z.object({
  channelId: z.number().int().positive(),
  amount: z.number().positive().finite(),
  orderNo: z.string().max(128).optional(),
  /** 凭证截图 base64 data URL（png/jpeg/webp/gif，≤ 配置上限） */
  voucherDataUrl: z.string().max(20_000_000).optional(),
  remark: z.string().max(255).optional(),
});

const adjustSchema = z.object({
  channelId: z.number().int().positive(),
  amount: z.coerce.number().finite().refine((v) => v !== 0, '调账金额不能为 0'),
  remark: z.string().max(255).optional(),
});

const listQuerySchema = paginationQuerySchema.extend({
  channelId: z.coerce.number().int().positive().optional(),
  type: z.enum(['recharge', 'adjust']).optional(),
});

export function channelFundsRoutes(
  s: AdminServices,
  voucherMaxBytes: number,
): Hono<AdminEnv> {
  return new Hono<AdminEnv>()
    .get('/', query(listQuerySchema), async (c) => {
      const q = c.req.valid('query');
      const p = parsePagination(q);
      const { limit, offset } = limitOffset(p);
      const conds = [];
      if (q.channelId) conds.push(eq(channelRecharges.channelId, q.channelId));
      if (q.type) conds.push(eq(channelRecharges.type, q.type));
      const where = conds.length ? and(...conds) : undefined;

      const result = await paginateQuery(
        p,
        s.db
          .select({
            id: channelRecharges.id,
            channelId: channelRecharges.channelId,
            channelName: channels.name,
            type: channelRecharges.type,
            amount: channelRecharges.amount,
            balanceAfter: channelRecharges.balanceAfter,
            orderNo: channelRecharges.orderNo,
            voucher: channelRecharges.voucher,
            remark: channelRecharges.remark,
            adminId: channelRecharges.adminId,
            adminEmail: admins.email,
            adminDisplayName: admins.displayName,
            createdAt: channelRecharges.createdAt,
          })
          .from(channelRecharges)
          .innerJoin(channels, eq(channelRecharges.channelId, channels.id))
          .leftJoin(admins, eq(channelRecharges.adminId, admins.id))
          .where(where)
          .orderBy(desc(channelRecharges.createdAt), desc(channelRecharges.id))
          .limit(limit)
          .offset(offset),
        s.db
          .select({ count: sql<number>`count(*)::int` })
          .from(channelRecharges)
          .where(where),
      );
      return c.json(result);
    })

    .post('/recharge', jsonBody(rechargeSchema), async (c) => {
      const body = c.req.valid('json');
      const result = await rechargeChannel(s, body, c.get('adminId'), voucherMaxBytes);
      await recordAudit(s.db, {
        actor: 'admin',
        adminId: c.get('adminId'),
        action: 'channel.recharge',
        targetType: 'channel',
        targetId: body.channelId,
        detail: {
          amount: String(body.amount),
          orderNo: body.orderNo ?? null,
          hasVoucher: !!body.voucherDataUrl,
          remark: body.remark ?? null,
        },
      });
      return c.json({ ok: true, ...result });
    })

    .post('/adjust', jsonBody(adjustSchema), async (c) => {
      const body = c.req.valid('json');
      const result = await adjustChannel(s, body, c.get('adminId'));
      await recordAudit(s.db, {
        actor: 'admin',
        adminId: c.get('adminId'),
        action: 'channel.adjust',
        targetType: 'channel',
        targetId: body.channelId,
        detail: { amount: String(body.amount), remark: body.remark ?? null },
      });
      return c.json({ ok: true, ...result });
    });
}
