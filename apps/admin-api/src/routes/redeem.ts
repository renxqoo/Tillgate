import { Hono } from 'hono';
import { eq, sql, and } from 'drizzle-orm';
import { redeemBatches, redeemCodes, users } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import { jsonBody, query } from '../lib/validation.js';
import { z } from 'zod';
import { recordAudit } from '../lib/audit.js';
import { generateRedeemCode, sha256Hex } from '../lib/secrets.js';
import {
  paginationQuerySchema,
  parsePagination,
  limitOffset,
  paginatedResult,
} from '../lib/pagination.js';
import type { AdminEnv } from '../middleware/session.js';

/**
 * 充值码管理（api-contract §4.7 / requirements 4.8）。
 *
 *   - 批次生成：一次性生成 count 张同面额码，明文只在此响应中下发一次（落库的是哈希）
 *   - 批次查询：列表（含已用数）
 *   - 批次内码明细：脱敏哈希/状态/兑换人
 *
 * 安全设计（data-model §3.12）：
 *   - code_hash 唯一（redeem_codes_code_hash_uq）→ 明文碰撞概率极低（160bit 熵）
 *   - 明文永不再现（即使管理员也只能看到脱敏哈希）
 *   - 面额创建后不可修改（data-model §3.12：改价需新建批次）
 */

const batchCreateSchema = z.object({
  name: z.string().min(1).max(64),
  remark: z.string().max(255).optional(),
  /** 面额（厘），正整数 */
  amount: z.number().int().positive(),
  /** 生成数量，1~10000 */
  count: z.number().int().min(1).max(10_000),
  expiresAt: z.string().datetime().optional(),
});

export function redeemAdminRoutes(db: Db): Hono<AdminEnv> {
  return new Hono<AdminEnv>()

    // 生成批次（明文一次性下发）
    .post('/api/admin/redeem-batches', jsonBody(batchCreateSchema), async (c) => {
      const body = c.req.valid('json');
      const adminId = c.get('adminId');
      const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;

      // createdBy 解析：机器令牌调用无 adminId → 兜底取第一个管理员（role=1）
      let creatorId = adminId;
      if (creatorId === undefined) {
        const admin = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.role, 1))
          .orderBy(users.id)
          .limit(1);
        if (admin.length === 0) {
          return c.json({ error: '系统无管理员账号，无法记录批次创建人' }, 400);
        }
        creatorId = admin[0]!.id;
      }

      // 单事务：建批次 + 批量插码
      const result = await db.transaction(async (tx) => {
        const [batch] = await tx
          .insert(redeemBatches)
          .values({
            name: body.name,
            remark: body.remark ?? null,
            amount: body.amount,
            total: body.count,
            usedCount: 0,
            createdBy: creatorId,
          })
          .returning();
        // 生成码明文 + 哈希，批量插入
        const codes: string[] = [];
        const rows: Array<{ batchId: number; codeHash: string; expiresAt: Date | null }> = [];
        for (let i = 0; i < body.count; i++) {
          const plaintext = generateRedeemCode();
          codes.push(plaintext);
          rows.push({ batchId: batch!.id, codeHash: sha256Hex(plaintext), expiresAt });
        }
        await tx.insert(redeemCodes).values(rows);
        return { batch: batch!, codes };
      });

      await recordAudit(db, {
        adminId,
        action: 'redeem_batch.create',
        targetType: 'redeem_batch',
        targetId: result.batch.id,
        detail: { name: body.name, amount: body.amount, count: body.count },
      });

      // 明文码只在此响应下发一次
      return c.json(
        {
          batch: {
            id: result.batch.id,
            name: result.batch.name,
            amount: result.batch.amount,
            total: result.batch.total,
          },
          codes: result.codes, // 明文，一次性
        },
        201,
      );
    })

    // 批次列表
    .get('/api/admin/redeem-batches', query(paginationQuerySchema), async (c) => {
      const p = parsePagination(c.req.valid('query'));
      const { limit, offset } = limitOffset(p);
      const [rows, countRows] = await Promise.all([
        db
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
        db.select({ count: sql<number>`count(*)::int` }).from(redeemBatches),
      ]);
      return c.json(paginatedResult(rows, Number(countRows[0]?.count ?? 0), p));
    })

    // 批次详情
    .get('/api/admin/redeem-batches/:id', async (c) => {
      const id = Number(c.req.param('id'));
      const rows = await db.select().from(redeemBatches).where(eq(redeemBatches.id, id)).limit(1);
      if (rows.length === 0) return c.json({ error: '批次不存在' }, 404);
      return c.json(rows[0]);
    })

    // 批次内码明细（脱敏哈希 + 状态 + 兑换人）
    .get('/api/admin/redeem-batches/:id/codes', query(paginationQuerySchema.extend({
      status: z.coerce.number().int().min(0).max(2).optional(),
    })), async (c) => {
      const id = Number(c.req.param('id'));
      const q = c.req.valid('query');
      const p = parsePagination(q);
      const { limit, offset } = limitOffset(p);
      const where = q.status !== undefined
        ? and(eq(redeemCodes.batchId, id), eq(redeemCodes.status, q.status))
        : eq(redeemCodes.batchId, id);
      const [rows, countRows] = await Promise.all([
        db
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
        db.select({ count: sql<number>`count(*)::int` }).from(redeemCodes).where(where),
      ]);
      return c.json(paginatedResult(rows, Number(countRows[0]?.count ?? 0), p));
    })

    // 作废单张码（管理员）
    .post('/api/admin/redeem-batches/codes/:codeId/revoke', async (c) => {
      const codeId = Number(c.req.param('codeId'));
      const adminId = c.get('adminId');
      const result = await db
        .update(redeemCodes)
        .set({ status: 2 })
        .where(and(eq(redeemCodes.id, codeId), eq(redeemCodes.status, 0)))
        .returning({ id: redeemCodes.id });
      if (result.length === 0) return c.json({ error: '码不存在或已使用/已作废' }, 404);
      await recordAudit(db, { adminId, action: 'redeem_code.revoke', targetType: 'redeem_code', targetId: codeId });
      return c.json({ ok: true });
    });
}
