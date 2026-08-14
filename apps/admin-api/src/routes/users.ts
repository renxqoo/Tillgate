import { Hono } from 'hono';
import { eq, and, or, ilike, sql, desc } from 'drizzle-orm';
import { users, rateCards, transactions, auditLogs } from '@ai-gateway/db/schema';
import { z } from 'zod';
import { HttpError, jsonBody, limitOffset, operationId, paginateQuery, paginationQuerySchema, parsePagination, query } from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import type { AdminServices } from '../services/index.js';
import { mapLedgerError, setUserPassword, updateUser, userProfileColumns } from '../services/users.js';

/**
 * 用户管理（api-contract §4.4）。
 *
 *   - GET  /：列表（搜索 q 走 subject/email/display_name 模糊 / 状态筛选 / 分页）
 *   - GET  /:id：详情
 *   - PATCH /:id：封禁/解封、绑定费率卡、调限流（规则见 services/users.updateUser）
 *   - POST /:id/set-password：管理员开通本地账号（初始密码 + 绑定默认费率卡）
 *   - POST /:id/adjust | /:id/gift：调账/赠送（ledger 事务 + 幂等键）
 *   - GET  /:id/transactions | /:id/audit-logs：管理员视角流水与审计
 */

const userListQuerySchema = paginationQuerySchema.extend({
  q: z.string().optional(),
  status: z.coerce.number().int().min(0).max(2).optional(),
  /** 企业/个人筛选：1=企业，0=个人 */
  enterprise: z.enum(['0', '1']).optional(),
});

const userUpdateSchema = z.object({
  /** 0 正常 / 1 封禁 / 2 注销 */
  status: z.number().int().min(0).max(2).optional(),
  rateCardId: z.number().int().positive().nullable().optional(),
  rpmLimit: z.number().int().min(1).nullable().optional(),
  tpmLimit: z.number().int().min(1).nullable().optional(),
  /** 透支上限（元，>=0）。信用模型：balance 允许降到 -credit_limit。 */
  creditLimit: z.number().min(0).optional(),
  /** 每日花费上限（元，>=0）。NULL=不限。 */
  dailySpendLimit: z.number().min(0).nullable().optional(),
  displayName: z.string().max(64).optional(),
  email: z.string().email().max(255).nullable().optional(),
  /** 是否企业用户（企业用户可购买团队套餐/席位） */
  isEnterprise: z.boolean().optional(),
  /** 封禁原因（写入 freeze_reason，便于审计/解冻判定） */
  freezeReason: z.string().max(128).nullable().optional(),
});

const setPasswordSchema = z.object({
  password: z.string().min(8).max(128),
});

const userAdjustSchema = z.object({
  /** 调账金额（元，小数），正=增加，负=扣减 */
  amount: z.coerce.number().refine((v) => v !== 0, '调账金额不能为 0'),
  remark: z.string().max(255).optional(),
});

const userGiftSchema = z.object({
  amount: z.coerce.number().positive(),
  remark: z.string().max(255).optional(),
});

export function userAdminRoutes(s: AdminServices): Hono<AdminEnv> {
  return new Hono<AdminEnv>()

    // 列表（搜索 + 状态筛选 + 分页）
    .get('/', query(userListQuerySchema), async (c) => {
      const q = c.req.valid('query');
      const p = parsePagination(q);
      const { limit, offset } = limitOffset(p);
      const conditions = [];
      if (q.q) {
        const like = `%${q.q}%`;
        conditions.push(
          or(ilike(users.subject, like), ilike(users.email, like), ilike(users.displayName, like))!,
        );
      }
      if (q.status !== undefined) conditions.push(eq(users.status, q.status));
      if (q.enterprise !== undefined) conditions.push(eq(users.isEnterprise, q.enterprise === '1'));
      const where = conditions.length ? and(...conditions) : undefined;

      const result = await paginateQuery(
        p,
        s.db
          .select(userProfileColumns)
          .from(users)
          .leftJoin(rateCards, eq(users.rateCardId, rateCards.id))
          .where(where)
          .orderBy(desc(users.id))
          .limit(limit)
          .offset(offset),
        s.db
          .select({ count: sql<number>`count(*)::int` })
          .from(users)
          .leftJoin(rateCards, eq(users.rateCardId, rateCards.id))
          .where(where),
      );
      return c.json(result);
    })

    // 详情
    .get('/:id', async (c) => {
      const id = Number(c.req.param('id'));
      const rows = await s.db
        .select(userProfileColumns)
        .from(users)
        .leftJoin(rateCards, eq(users.rateCardId, rateCards.id))
        .where(eq(users.id, id))
        .limit(1);
      if (rows.length === 0) throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在');
      return c.json(rows[0]);
    })

    // PATCH：封禁/解封/绑卡/限流/资料
    .patch('/:id', jsonBody(userUpdateSchema), async (c) => {
      const id = Number(c.req.param('id'));
      const updated = await updateUser(s, id, c.req.valid('json'), c.get('adminId'));
      return c.json(updated);
    })

    // 管理员开通本地账号（设置初始密码 + 绑定默认费率卡）
    .post('/:id/set-password', jsonBody(setPasswordSchema), async (c) => {
      const id = Number(c.req.param('id'));
      await setUserPassword(s, id, c.req.valid('json').password, c.get('adminId'));
      return c.json({ ok: true });
    })

    // 手动调账（正负皆可，扣减拒绝透支）
    .post('/:id/adjust', jsonBody(userAdjustSchema), async (c) => {
      const id = Number(c.req.param('id'));
      const body = c.req.valid('json');
      const amountStr = String(body.amount);
      try {
        const result = await s.ledger.adminAdjust({
          operationId: operationId(c),
          userId: id,
          amount: amountStr,
          adminId: c.get('adminId'),
          remark: body.remark ?? `管理员调账 ${body.amount > 0 ? '+' : ''}${amountStr}`,
        });
        return c.json({ ok: true, balanceBefore: result.balanceBefore, balanceAfter: result.balanceAfter });
      } catch (error) {
        throw mapLedgerError(error);
      }
    })

    // 手动赠送（type=gift）
    .post('/:id/gift', jsonBody(userGiftSchema), async (c) => {
      const id = Number(c.req.param('id'));
      const body = c.req.valid('json');
      try {
        const result = await s.ledger.adminGift({
          operationId: operationId(c),
          userId: id,
          amount: String(body.amount),
          adminId: c.get('adminId'),
          remark: body.remark ?? '管理员赠送',
        });
        return c.json({ ok: true, balanceBefore: result.balanceBefore, balanceAfter: result.balanceAfter });
      } catch (error) {
        throw mapLedgerError(error);
      }
    })

    // 用户资金流水（管理员视角）
    .get('/:id/transactions', query(paginationQuerySchema), async (c) => {
      const id = Number(c.req.param('id'));
      const p = parsePagination(c.req.valid('query'));
      const { limit, offset } = limitOffset(p);
      const result = await paginateQuery(
        p,
        s.db
          .select()
          .from(transactions)
          .where(eq(transactions.userId, id))
          .orderBy(sql`${transactions.createdAt} desc`)
          .limit(limit)
          .offset(offset),
        s.db.select({ count: sql<number>`count(*)::int` }).from(transactions).where(eq(transactions.userId, id)),
      );
      return c.json(result);
    })

    // 用户审计日志（管理员视角，target_type=user）
    .get('/:id/audit-logs', query(paginationQuerySchema), async (c) => {
      const id = Number(c.req.param('id'));
      const p = parsePagination(c.req.valid('query'));
      const { limit, offset } = limitOffset(p);
      const target = and(eq(auditLogs.targetType, 'user'), eq(auditLogs.targetId, String(id)));
      const result = await paginateQuery(
        p,
        s.db
          .select()
          .from(auditLogs)
          .where(target)
          .orderBy(sql`${auditLogs.createdAt} desc`)
          .limit(limit)
          .offset(offset),
        s.db.select({ count: sql<number>`count(*)::int` }).from(auditLogs).where(target),
      );
      return c.json(result);
    });
}
