import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { rateCards, rateCardCoefficients, users } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import { jsonBody } from '../lib/validation.js';
import { z } from 'zod';
import { recordAudit } from '../lib/audit.js';
import type { AdminEnv } from '../middleware/session.js';

/**
 * 费率卡管理（api-contract §4.9）。
 *
 * 定价模型（requirements 4.7 / data-model §3.8）：
 *   用户价 = 官方价（model_mappings）× 费率卡系数
 *   - 每张卡必有且仅有一行 scope=global 兜底系数
 *   - 系数 numeric(6,3)：1.0 = 按官方价原价；0.8 = 八折；1.5 = 加价 50%
 *   - 账户绑卡：users.rate_card_id
 *
 * 约束：
 *   - name 唯一（rate_cards_name_uq）
 *   - 创建时强制带 global 系数（应用层保证，data-model §3.9 约束）
 *   - 系数合法范围 [0, 9.999]（numeric(6,3) 上限；负数/超大拒绝）
 */
const rateCardCreateSchema = z.object({
  name: z.string().min(1).max(32),
  description: z.string().max(255).optional(),
  /** 全局兜底系数，必填，范围 [0, 9.999] */
  coefficient: z.number().min(0).max(9.999),
});

const rateCardUpdateSchema = z.object({
  name: z.string().min(1).max(32).optional(),
  description: z.string().max(255).nullable().optional(),
  /** 0 启用 / 1 停用 */
  status: z.number().int().min(0).max(1).optional(),
  /** 更新全局系数（可选） */
  coefficient: z.number().min(0).max(9.999).optional(),
});

/** 系数保留 3 位小数的字符串（numeric 列） */
function fmtCoeff(v: number): string {
  return v.toFixed(3);
}

export function rateCardAdminRoutes(db: Db): Hono<AdminEnv> {
  return new Hono<AdminEnv>()

    // 列表
    .get('/api/admin/rate-cards', async (c) => {
      const rows = await db
        .select({
          id: rateCards.id,
          name: rateCards.name,
          description: rateCards.description,
          status: rateCards.status,
          createdAt: rateCards.createdAt,
          updatedAt: rateCards.updatedAt,
        })
        .from(rateCards)
        .orderBy(rateCards.id);
      // 附加全局系数（一行 scope=global）
      const ids = rows.map((r) => r.id);
      const coeffs = ids.length
        ? await db
            .select({
              rateCardId: rateCardCoefficients.rateCardId,
              coefficient: rateCardCoefficients.coefficient,
            })
            .from(rateCardCoefficients)
            .where(eq(rateCardCoefficients.scope, 'global'))
        : [];
      const coeffMap = new Map(coeffs.map((x) => [x.rateCardId, x.coefficient]));
      const list = rows.map((r) => ({ ...r, coefficient: coeffMap.get(r.id) ?? '1.000' }));
      return c.json({ list, total: list.length });
    })

    // 创建（必须带全局系数）
    .post('/api/admin/rate-cards', jsonBody(rateCardCreateSchema), async (c) => {
      const body = c.req.valid('json');
      const adminId = c.get('adminId');
      // 单事务：建卡 + 写 global 系数行（data-model §3.9 约束：每卡必有且仅有一行 global）
      const result = await db.transaction(async (tx) => {
        const [card] = await tx
          .insert(rateCards)
          .values({ name: body.name, description: body.description ?? null, status: 0 })
          .returning();
        await tx.insert(rateCardCoefficients).values({
          rateCardId: card!.id,
          scope: 'global',
          coefficient: fmtCoeff(body.coefficient),
        });
        return card!;
      });
      await recordAudit(db, {
        adminId,
        action: 'rate_card.create',
        targetType: 'rate_card',
        targetId: result.id,
        detail: { name: body.name, coefficient: body.coefficient },
      });
      return c.json({ ...result, coefficient: fmtCoeff(body.coefficient) }, 201);
    })

    // 更新（名称/描述/状态/全局系数）
    .patch('/api/admin/rate-cards/:id', jsonBody(rateCardUpdateSchema), async (c) => {
      const id = Number(c.req.param('id'));
      const body = c.req.valid('json');
      const adminId = c.get('adminId');
      const result = await db.transaction(async (tx) => {
        const update: Record<string, unknown> = { updatedAt: new Date() };
        if (body.name !== undefined) update.name = body.name;
        if (body.description !== undefined) update.description = body.description;
        if (body.status !== undefined) update.status = body.status;
        const [updated] = await tx
          .update(rateCards)
          .set(update)
          .where(eq(rateCards.id, id))
          .returning();
        if (!updated) return null;
        if (body.coefficient !== undefined) {
          // 更新 global 系数行
          await tx
            .update(rateCardCoefficients)
            .set({ coefficient: fmtCoeff(body.coefficient) })
            .where(eq(rateCardCoefficients.rateCardId, id));
        }
        return updated;
      });
      if (!result) return c.json({ error: '费率卡不存在' }, 404);
      await recordAudit(db, {
        adminId,
        action: 'rate_card.update',
        targetType: 'rate_card',
        targetId: id,
        detail: body,
      });
      return c.json(result);
    })

    // 查看绑定该卡的账户（api-contract §4.9）
    .get('/api/admin/rate-cards/:id/users', async (c) => {
      const id = Number(c.req.param('id'));
      const rows = await db
        .select({
          id: users.id,
          subject: users.subject,
          displayName: users.displayName,
          email: users.email,
          status: users.status,
          balance: users.balance,
        })
        .from(users)
        .where(eq(users.rateCardId, id))
        .orderBy(users.id);
      return c.json({ list: rows, total: rows.length });
    })

    // （可选）删除：仅当无用户绑定时允许（防误删导致账户孤儿）
    .delete('/api/admin/rate-cards/:id', async (c) => {
      const id = Number(c.req.param('id'));
      const adminId = c.get('adminId');
      // 检查是否仍有用户绑定
      const bound = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.rateCardId, id))
        .limit(1);
      if (bound.length > 0) {
        return c.json({ error: '该费率卡仍有用户绑定，无法删除（请先迁移用户）' }, 409);
      }
      await db.delete(rateCardCoefficients).where(eq(rateCardCoefficients.rateCardId, id));
      const result = await db.delete(rateCards).where(eq(rateCards.id, id)).returning({ id: rateCards.id });
      if (result.length === 0) return c.json({ error: '费率卡不存在' }, 404);
      await recordAudit(db, { adminId, action: 'rate_card.delete', targetType: 'rate_card', targetId: id });
      return c.json({ ok: true });
    })

    // 健康自检：全局系数行是否存在（data-model §3.9 约束校验）
    .get('/api/admin/rate-cards/:id/health', async (c) => {
      const id = Number(c.req.param('id'));
      const globalRow = await db
        .select({ coefficient: rateCardCoefficients.coefficient })
        .from(rateCardCoefficients)
        .where(sql`${rateCardCoefficients.rateCardId} = ${id} and ${rateCardCoefficients.scope} = 'global'`)
        .limit(1);
      return c.json({ hasGlobalCoefficient: globalRow.length === 1, coefficient: globalRow[0]?.coefficient ?? null });
    });
}
