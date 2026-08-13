import { Hono } from 'hono';
import { eq, sql, and } from 'drizzle-orm';
import { redeemBatches, redeemCodes } from '@ai-gateway/db/schema';
import { z } from 'zod';
import { HttpError, jsonBody, limitOffset, paginateQuery, paginationQuerySchema, parsePagination, query, recordAudit } from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import type { AdminServices } from '../services/index.js';
import { createRedeemBatch } from '../services/redeem.js';

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
  /** 面额（元，正小数） */
  amount: z.coerce.number().positive(),
  /** 生成数量，1~10000 */
  count: z.number().int().min(1).max(10_000),
  /** 过期时间，兼容 datetime-local（YYYY-MM-DDTHH:mm）与完整 ISO 8601 */
  expiresAt: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), '无效的过期时间')
    .optional(),
});

const batchCodesQuerySchema = paginationQuerySchema.extend({
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
    .get('/', query(paginationQuerySchema), async (c) => {
      const p = parsePagination(c.req.valid('query'));
      const { limit, offset } = limitOffset(p);
      const result = await paginateQuery(
        p,
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
          .orderBy(sql`${redeemBatches.id} desc`)
          .limit(limit)
          .offset(offset),
        s.db.select({ count: sql<number>`count(*)::int` }).from(redeemBatches),
      );
      return c.json(result);
    })

    // 批次详情
    .get('/:id', async (c) => {
      const id = Number(c.req.param('id'));
      const rows = await s.db.select().from(redeemBatches).where(eq(redeemBatches.id, id)).limit(1);
      if (rows.length === 0) throw new HttpError(404, 'REDEEM_BATCH_NOT_FOUND', '批次不存在');
      return c.json(rows[0]);
    })

    // 批次内码明细（脱敏哈希 + 状态 + 兑换人）
    .get('/:id/codes', query(batchCodesQuerySchema), async (c) => {
      const id = Number(c.req.param('id'));
      const q = c.req.valid('query');
      const p = parsePagination(q);
      const { limit, offset } = limitOffset(p);
      const where = q.status !== undefined
        ? and(eq(redeemCodes.batchId, id), eq(redeemCodes.status, q.status))
        : eq(redeemCodes.batchId, id);
      const result = await paginateQuery(
        p,
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
          .orderBy(redeemCodes.id)
          .limit(limit)
          .offset(offset),
        s.db.select({ count: sql<number>`count(*)::int` }).from(redeemCodes).where(where),
      );
      return c.json(result);
    })

    // 作废单张码（管理员）
    .post('/codes/:codeId/revoke', async (c) => {
      const codeId = Number(c.req.param('codeId'));
      const result = await s.db
        .update(redeemCodes)
        .set({ status: 2 })
        .where(and(eq(redeemCodes.id, codeId), eq(redeemCodes.status, 0)))
        .returning({ id: redeemCodes.id });
      if (result.length === 0) throw new HttpError(404, 'REDEEM_CODE_NOT_FOUND', '码不存在或已使用/已作废');
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
