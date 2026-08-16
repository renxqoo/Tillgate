import { Hono } from 'hono';
import { eq, and, sql } from 'drizzle-orm';
import { redeemBatches, redeemCodes } from '@ai-gateway/db/schema';
import { z } from 'zod';
import {
  HttpError, jsonBody, paginateQuery, query, recordAudit, intParam,
  listQuerySchema, buildList, countAll,
  sortQuerySchema, paginationQuerySchema } from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import type { AdminServices } from '../services/index.js';
import { createRedeemBatch } from '../services/redeem.js';
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

const batchCodesQuerySchema = paginationQuerySchema.extend({
  ...sortQuerySchema.shape,
  status: z.coerce.number().int().min(0).max(2).optional(),
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
    .get('/', query(listQuerySchema), async (c) => {
      const input = c.req.valid('query');
      const { page, limit, offset, where, orderBy } = buildList(input, {
        search: [redeemBatches.name, redeemBatches.remark],
        sort: {
          by: { id: redeemBatches.id, name: redeemBatches.name, amount: redeemBatches.amount, createdAt: redeemBatches.createdAt },
          fallback: 'createdAt',
          tiebreaker: redeemBatches.id,
        },
      });
      const result = await paginateQuery(
        page,
        s.db
          .select({
            id: redeemBatches.id,
            name: redeemBatches.name,
            remark: redeemBatches.remark,
            amount: redeemBatches.amount,
            total: redeemBatches.total,
            usedCount: redeemBatches.usedCount,
            createdBy: redeemBatches.createdBy,
            createdAt: redeemBatches.createdAt,
          })
          .from(redeemBatches)
          .where(where)
          .orderBy(...orderBy)
          .limit(limit)
          .offset(offset),
        countAll(s.db, redeemBatches, where),
      );
      return c.json(result);
    })

    // 批次详情
    .get('/:id', async (c) => {
      const id = intParam(c, 'id');
      const rows = await s.db.select().from(redeemBatches).where(eq(redeemBatches.id, id)).limit(1);
      if (rows.length === 0) throw new HttpError('REDEEM_BATCH_NOT_FOUND', '批次不存在');
      return c.json(rows[0]);
    })

    // 批次内码明细（脱敏哈希 + 状态 + 兑换人）
    .get('/:id/codes', query(batchCodesQuerySchema), async (c) => {
      const id = intParam(c, 'id');
      const q = c.req.valid('query');
      // 兑换码只有哈希无文本列，不提供 q；默认 id desc（新生成在前）
      const { page, limit, offset, where, orderBy } = buildList(q, {
        conditions: [
          eq(redeemCodes.batchId, id),
          q.status !== undefined ? eq(redeemCodes.status, q.status) : undefined,
        ],
        sort: { by: { id: redeemCodes.id, usedAt: redeemCodes.usedAt }, fallback: 'id', tiebreaker: redeemCodes.id },
      });
      const result = await paginateQuery(
        page,
        s.db
          .select({
            id: redeemCodes.id,
            // 脱敏：只显示哈希前 8 位 + ...（明文永不回显）
            codeMasked: sql<string>`left(${redeemCodes.codeHash}, 8) || '...'`,
            status: redeemCodes.status,
            usedBy: redeemCodes.usedBy,
            usedAt: redeemCodes.usedAt,
            expiresAt: redeemCodes.expiresAt,
          })
          .from(redeemCodes)
          .where(where)
          .orderBy(...orderBy)
          .limit(limit)
          .offset(offset),
        countAll(s.db, redeemCodes, where),
      );
      return c.json(result);
    })

    // 作废单张码（管理员）
    .post('/codes/:codeId/revoke', async (c) => {
      const codeId = intParam(c, 'codeId');
      const result = await s.db
        .update(redeemCodes)
        .set({ status: 2 })
        .where(and(eq(redeemCodes.id, codeId), eq(redeemCodes.status, 0)))
        .returning({ id: redeemCodes.id });
      if (result.length === 0) throw new HttpError('REDEEM_CODE_NOT_FOUND', '码不存在或已使用/已作废');
      await recordAudit(s.db, {
        actor: 'admin',
        adminId: c.get('adminId'),
        action: 'redeem_code.revoke',
        targetType: 'redeem_code',
        targetId: codeId,
      });
      return c.json({ ok: true });
    });
}
