import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { rateCards, rateCardCoefficients, users } from '@ai-gateway/db/schema';
import { z } from 'zod';
import {
  HttpError, jsonBody, recordAudit, intParam,
  paginateQuery, query, listQuerySchema, buildList, countAll } from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import type { AdminServices } from '../services/index.js';
import { createRateCard, fmtCoeff, updateRateCard } from '../services/rate-cards.js';

/**
 * 费率卡管理（api-contract §4.9）。
 *
 * 定价模型：用户价 = 官方价（model_mappings）× 费率卡系数。
 *   - 每张卡必有且仅有一行 scope=global 兜底系数（应用层保证，data-model §3.9）
 *   - 系数合法范围 [0, 9.999]（numeric(6,3) 上限；负数/超大拒绝）
 *   - 删除仅当无用户绑定时允许（防孤儿账户）
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

export function rateCardAdminRoutes(s: AdminServices): Hono<AdminEnv> {
  return (
    new Hono<AdminEnv>()

      // 列表（附 global 系数）
      .get('/', query(listQuerySchema), async (c) => {
        const input = c.req.valid('query');
        const { page, limit, offset, where, orderBy } = buildList(input, {
          search: [rateCards.name, rateCards.description],
          sort: {
            by: { id: rateCards.id, name: rateCards.name, status: rateCards.status, createdAt: rateCards.createdAt },
            fallback: 'createdAt',
            tiebreaker: rateCards.id,
          },
        });
        const result = await paginateQuery(
          page,
          s.db
            .select({
              id: rateCards.id,
              name: rateCards.name,
              description: rateCards.description,
              status: rateCards.status,
              createdAt: rateCards.createdAt,
              updatedAt: rateCards.updatedAt,
            })
            .from(rateCards)
            .where(where)
            .orderBy(...orderBy)
            .limit(limit)
            .offset(offset),
          countAll(s.db, rateCards, where),
        );
        const ids = result.list.map((r) => r.id);
        const coeffs = ids.length
          ? await s.db
              .select({
                rateCardId: rateCardCoefficients.rateCardId,
                coefficient: rateCardCoefficients.coefficient,
              })
              .from(rateCardCoefficients)
              .where(eq(rateCardCoefficients.scope, 'global'))
          : [];
        const coeffMap = new Map(coeffs.map((x) => [x.rateCardId, x.coefficient]));
        const list = result.list.map((r) => ({ ...r, coefficient: coeffMap.get(r.id) ?? '1.000' }));
        return c.json({ ...result, list });
      })

      // 创建（必须带全局系数，事务见 service）
      .post('/', jsonBody(rateCardCreateSchema), async (c) => {
        const body = c.req.valid('json');
        const card = await createRateCard(s, body, c.get('adminId'));
        return c.json({ ...card, coefficient: fmtCoeff(body.coefficient) }, 201);
      })

      // 更新（名称/描述/状态/全局系数）
      .patch('/:id', jsonBody(rateCardUpdateSchema), async (c) => {
        const id = intParam(c, 'id');
        const updated = await updateRateCard(s, id, c.req.valid('json'), c.get('adminId'));
        return c.json(updated);
      })

      // 查看绑定该卡的账户（api-contract §4.9）
      .get('/:id/users', query(listQuerySchema), async (c) => {
        const id = intParam(c, 'id');
        const input = c.req.valid('query');
        const { page, limit, offset, where, orderBy } = buildList(input, {
          search: [users.subject, users.displayName, users.email],
          conditions: [eq(users.rateCardId, id)],
          sort: {
            by: { id: users.id, subject: users.subject, balance: users.balance, createdAt: users.createdAt },
            fallback: 'createdAt',
            tiebreaker: users.id,
          },
        });
        const result = await paginateQuery(
          page,
          s.db
            .select({
              id: users.id,
              subject: users.subject,
              displayName: users.displayName,
              email: users.email,
              status: users.status,
              balance: users.balance,
              reservedBalance: users.reservedBalance,
              availableBalance: sql<string>`${users.balance} - ${users.reservedBalance}`,
            })
            .from(users)
            .where(where)
            .orderBy(...orderBy)
            .limit(limit)
            .offset(offset),
          countAll(s.db, users, where),
        );
        return c.json(result);
      })

      // 删除：仅当无用户绑定时允许（防误删导致账户孤儿）
      .delete('/:id', async (c) => {
        const id = intParam(c, 'id');
        const bound = await s.db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.rateCardId, id))
          .limit(1);
        if (bound.length > 0) {
          throw new HttpError(
            'RATE_CARD_IN_USE',
            '该费率卡仍有用户绑定，无法删除（请先迁移用户）',
          );
        }
        await s.db.delete(rateCardCoefficients).where(eq(rateCardCoefficients.rateCardId, id));
        const result = await s.db
          .delete(rateCards)
          .where(eq(rateCards.id, id))
          .returning({ id: rateCards.id });
        if (result.length === 0) throw new HttpError('RATE_CARD_NOT_FOUND', '费率卡不存在');
        await recordAudit(s.db, {
          actor: 'admin',
          adminId: c.get('adminId'),
          action: 'rate_card.delete',
          targetType: 'rate_card',
          targetId: id,
        });
        return c.json({ ok: true });
      })

      // 健康自检：全局系数行是否存在（data-model §3.9 约束校验）
      .get('/:id/health', async (c) => {
        const id = intParam(c, 'id');
        const globalRow = await s.db
          .select({ coefficient: rateCardCoefficients.coefficient })
          .from(rateCardCoefficients)
          .where(
            sql`${rateCardCoefficients.rateCardId} = ${id} and ${rateCardCoefficients.scope} = 'global'`,
          )
          .limit(1);
        return c.json({
          hasGlobalCoefficient: globalRow.length === 1,
          coefficient: globalRow[0]?.coefficient ?? null,
        });
      })
  );
}
