import { Hono } from 'hono';
import { z } from 'zod';
import { intParam, jsonBody, query, listQuerySchema } from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import type { AdminServices } from '../services/index.js';
import {
  batchCodesQuerySchema, createRedeemBatch, getRedeemBatch, listRedeemBatchCodes, listRedeemBatches, revokeRedeemCode,
} from '../services/redeem.js';
import { MONEY_MAX } from '@ai-gateway/http';

/**
 * 充值码管理（api-contract §4.7 / requirements 4.8）。
 *
 *   - POST /：生成批次，明文码只在此响应中下发一次（落库的是哈希）
 *   - GET  /：批次列表（含已用数）
 *   - GET  /:id、/:id/codes：批次详情与码明细（脱敏哈希/状态/兑换人）
 *   - POST /codes/:codeId/revoke：作废单张码
 *
 * 安全（data-model §3.12）：明文永不再现；面额创建后不可修改（改价需新建批次）。
 */

const batchCreateSchema = z.object({
  name: z.string().min(1).max(64),
  remark: z.string().max(255).optional(),
  /** 面额（元，正小数）；finite+上限与调账/赠送统一（MONEY_MAX）——'1e999'→Infinity 曾穿透 .positive() */
  amount: z.coerce
    .number()
    .positive()
    .finite()
    .refine((v) => v <= MONEY_MAX, `面额不得超过 ${MONEY_MAX} 元`),
  /** 生成数量，1~10000 */
  count: z.number().int().min(1).max(10_000),
  /** 过期时间，兼容 datetime-local（YYYY-MM-DDTHH:mm）与完整 ISO 8601 */
  expiresAt: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), '无效的过期时间')
    .optional(),
});

export function redeemAdminRoutes(s: AdminServices): Hono<AdminEnv> {
  return new Hono<AdminEnv>()

    // 生成批次（明文一次性下发）
    .post('/', jsonBody(batchCreateSchema), async (c) => {
      const body = c.req.valid('json');
      const result = await createRedeemBatch(
        s,
        {
          name: body.name,
          remark: body.remark,
          amount: body.amount,
          count: body.count,
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
        },
        c.get('adminId'),
      );
      return c.json(result, 201);
    })

    // 批次列表
    .get('/', query(listQuerySchema), async (c) =>
      c.json(await listRedeemBatches(s, c.req.valid('query'))),
    )

    // 批次详情
    .get('/:id', async (c) => c.json(await getRedeemBatch(s, intParam(c, 'id'))))

    // 批次内码明细（脱敏哈希 + 状态 + 兑换人）
    .get('/:id/codes', query(batchCodesQuerySchema), async (c) =>
      c.json(await listRedeemBatchCodes(s, intParam(c, 'id'), c.req.valid('query'))),
    )

    // 作废单张码（管理员）
    .post('/codes/:codeId/revoke', async (c) => {
      await revokeRedeemCode(s, intParam(c, 'codeId'), c.get('adminId'));
      return c.json({ ok: true });
    });
}
