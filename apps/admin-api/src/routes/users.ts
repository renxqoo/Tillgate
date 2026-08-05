import { Hono } from 'hono';
import { eq, and, or, ilike, sql } from 'drizzle-orm';
import { users, rateCards, transactions, auditLogs, apiKeys } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import { jsonBody, query } from '../lib/validation.js';
import { z } from 'zod';
import { recordAudit } from '../lib/audit.js';
import { changeBalance, recordTransaction, unfreezeIfBadDebt } from '../lib/balance.js';
import { getAdminRedis } from '../lib/route-invalidation.js';
import {
  paginationQuerySchema,
  parsePagination,
  limitOffset,
  paginatedResult,
} from '../lib/pagination.js';
import type { AdminEnv } from '../middleware/session.js';

/**
 * 用户管理（api-contract §4.4）。
 *
 *   - 列表：搜索（q 走 subject/email/display_name 模糊）/状态筛选/分页
 *   - PATCH：封禁/解封、绑定费率卡、调限流
 *   - adjust：手动调账（正负皆可，写 transactions type=manual + audit）
 *
 * 资损注意：调账走原子条件 UPDATE + 流水（balance.ts），与 worker 结算同口径，
 *           避免并发更新丢失；审计落 audit_logs（detail 含变更前后）。
 */

const userListQuerySchema = paginationQuerySchema.extend({
  q: z.string().optional(),
  status: z.coerce.number().int().min(0).max(2).optional(),
});

const userUpdateSchema = z.object({
  /** 0 正常 / 1 封禁 / 2 注销 */
  status: z.number().int().min(0).max(2).optional(),
  rateCardId: z.number().int().positive().nullable().optional(),
  rpmLimit: z.number().int().min(1).nullable().optional(),
  tpmLimit: z.number().int().min(1).nullable().optional(),
  displayName: z.string().max(64).optional(),
  email: z.string().email().max(255).nullable().optional(),
  /** 封禁原因（写入 freeze_reason，便于审计/解冻判定） */
  freezeReason: z.string().max(128).nullable().optional(),
});

const userAdjustSchema = z.object({
  /** 调账金额（厘），正=增加，负=扣减 */
  amount: z.number().int().refine((v) => v !== 0, '调账金额不能为 0'),
  remark: z.string().max(255).optional(),
});

export function userAdminRoutes(db: Db): Hono<AdminEnv> {
  return new Hono<AdminEnv>()

    // 列表（搜索 + 状态筛选 + 分页）
    .get('/api/admin/users', query(userListQuerySchema), async (c) => {
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
      const where = conditions.length ? and(...conditions) : undefined;

      const [rows, countRows] = await Promise.all([
        db
          .select({
            id: users.id,
            issuer: users.issuer,
            subject: users.subject,
            identityProvider: users.identityProvider,
            email: users.email,
            displayName: users.displayName,
            role: users.role,
            rateCardId: users.rateCardId,
            rateCardName: rateCards.name,
            balance: users.balance,
            status: users.status,
            freezeReason: users.freezeReason,
            rpmLimit: users.rpmLimit,
            tpmLimit: users.tpmLimit,
            lastLoginAt: users.lastLoginAt,
            createdAt: users.createdAt,
          })
          .from(users)
          .leftJoin(rateCards, eq(users.rateCardId, rateCards.id))
          .where(where)
          .orderBy(users.id)
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(users)
          .leftJoin(rateCards, eq(users.rateCardId, rateCards.id))
          .where(where),
      ]);
      return c.json(paginatedResult(rows, Number(countRows[0]?.count ?? 0), p));
    })

    // 详情
    .get('/api/admin/users/:id', async (c) => {
      const id = Number(c.req.param('id'));
      const rows = await db
        .select({
          id: users.id,
          issuer: users.issuer,
          subject: users.subject,
          identityProvider: users.identityProvider,
          email: users.email,
          displayName: users.displayName,
          role: users.role,
          rateCardId: users.rateCardId,
          rateCardName: rateCards.name,
          balance: users.balance,
          status: users.status,
          freezeReason: users.freezeReason,
          rpmLimit: users.rpmLimit,
          tpmLimit: users.tpmLimit,
          lastLoginAt: users.lastLoginAt,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
        })
        .from(users)
        .leftJoin(rateCards, eq(users.rateCardId, rateCards.id))
        .where(eq(users.id, id))
        .limit(1);
      if (rows.length === 0) return c.json({ error: '用户不存在' }, 404);
      return c.json(rows[0]);
    })

    // PATCH：封禁/解封/绑卡/限流
    .patch('/api/admin/users/:id', jsonBody(userUpdateSchema), async (c) => {
      const id = Number(c.req.param('id'));
      const body = c.req.valid('json');
      const adminId = c.get('adminId');

      // 绑卡前校验费率卡存在且启用
      if (body.rateCardId !== undefined && body.rateCardId !== null) {
        const card = await db
          .select({ id: rateCards.id, status: rateCards.status })
          .from(rateCards)
          .where(eq(rateCards.id, body.rateCardId))
          .limit(1);
        if (card.length === 0) return c.json({ error: '费率卡不存在' }, 400);
        if (card[0]!.status !== 0) return c.json({ error: '费率卡已停用，无法绑定' }, 400);
      }

      const update: Record<string, unknown> = { updatedAt: new Date() };
      if (body.status !== undefined) update.status = body.status;
      if (body.rateCardId !== undefined) update.rateCardId = body.rateCardId;
      if (body.rpmLimit !== undefined) update.rpmLimit = body.rpmLimit;
      if (body.tpmLimit !== undefined) update.tpmLimit = body.tpmLimit;
      if (body.displayName !== undefined) update.displayName = body.displayName;
      if (body.email !== undefined) update.email = body.email;
      // 封禁时记原因；解封清空原因
      if (body.status === 1) update.freezeReason = body.freezeReason ?? '管理员封禁';
      if (body.status === 0) update.freezeReason = null;

      const [updated] = await db.update(users).set(update).where(eq(users.id, id)).returning();
      if (!updated) return c.json({ error: '用户不存在' }, 404);

      // #5 修复：封禁/解封/限流变更时清 gateway auth cache（防封禁后 60s 内 key 仍可用）
      // auth:key:{hash} 缓存 TTL 60s，不主动清则封禁最多延迟 60 秒生效
      if (body.status !== undefined || body.rpmLimit !== undefined || body.tpmLimit !== undefined) {
        const keys = await db.select({ keyHash: apiKeys.keyHash }).from(apiKeys).where(eq(apiKeys.userId, id));
        const redis = getAdminRedis();
        if (keys.length > 0 && redis) {
          await Promise.all(keys.map((k) => redis.del(`auth:key:${k.keyHash}`).catch(() => {})));
        }
      }

      await recordAudit(db, {
        adminId,
        action: 'user.update',
        targetType: 'user',
        targetId: id,
        detail: body,
      });
      return c.json(updated);
    })

    // 手动调账（正负皆可）
    .post('/api/admin/users/:id/adjust', jsonBody(userAdjustSchema), async (c) => {
      const id = Number(c.req.param('id'));
      const body = c.req.valid('json');
      const adminId = c.get('adminId');

      // 扣减时检查不透支；增加时不检查
      const result = await changeBalance(db, id, body.amount, {
        checkSufficient: body.amount < 0,
        redis: getAdminRedis(),
      });
      if (!result.ok) {
        if (result.reason === 'not_found') return c.json({ error: '用户不存在' }, 404);
        return c.json({ error: '余额不足，调账失败（拒绝透支）' }, 400);
      }

      // 写流水（type=manual）
      await recordTransaction(db, {
        userId: id,
        type: 'manual',
        amount: body.amount,
        balanceBefore: result.balanceBefore,
        balanceAfter: result.balanceAfter,
        refType: 'admin_adjust',
        refId: adminId != null ? String(adminId) : undefined,
        remark: body.remark ?? `管理员调账 ${body.amount > 0 ? '+' : ''}${body.amount}`,
        createdBy: adminId ?? null,
      });

      // 增加余额后尝试解冻（坏账冻结自动解除）
      if (body.amount > 0) await unfreezeIfBadDebt(db, id);

      await recordAudit(db, {
        adminId,
        action: 'user.adjust',
        targetType: 'user',
        targetId: id,
        detail: { amount: body.amount, before: result.balanceBefore, after: result.balanceAfter, remark: body.remark },
      });
      return c.json({ ok: true, balanceBefore: result.balanceBefore, balanceAfter: result.balanceAfter });
    })

    // 用户资金流水（管理员视角）
    .get('/api/admin/users/:id/transactions', query(paginationQuerySchema), async (c) => {
      const id = Number(c.req.param('id'));
      const p = parsePagination(c.req.valid('query'));
      const { limit, offset } = limitOffset(p);
      const [rows, countRows] = await Promise.all([
        db
          .select()
          .from(transactions)
          .where(eq(transactions.userId, id))
          .orderBy(sql`${transactions.createdAt} desc`)
          .limit(limit)
          .offset(offset),
        db.select({ count: sql<number>`count(*)::int` }).from(transactions).where(eq(transactions.userId, id)),
      ]);
      return c.json(paginatedResult(rows, Number(countRows[0]?.count ?? 0), p));
    })

    // 用户审计日志（管理员视角，target_type=user）
    .get('/api/admin/users/:id/audit-logs', query(paginationQuerySchema), async (c) => {
      const id = Number(c.req.param('id'));
      const p = parsePagination(c.req.valid('query'));
      const { limit, offset } = limitOffset(p);
      const [rows, countRows] = await Promise.all([
        db
          .select()
          .from(auditLogs)
          .where(and(eq(auditLogs.targetType, 'user'), eq(auditLogs.targetId, String(id))))
          .orderBy(sql`${auditLogs.createdAt} desc`)
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(auditLogs)
          .where(and(eq(auditLogs.targetType, 'user'), eq(auditLogs.targetId, String(id)))),
      ]);
      return c.json(paginatedResult(rows, Number(countRows[0]?.count ?? 0), p));
    })

    // 手动赠送（管理员给用户加赠送额度，type=gift）
    .post('/api/admin/users/:id/gift', jsonBody(z.object({ amount: z.number().int().positive(), remark: z.string().max(255).optional() })), async (c) => {
      const id = Number(c.req.param('id'));
      const body = c.req.valid('json');
      const adminId = c.get('adminId');
      const result = await changeBalance(db, id, body.amount, { redis: getAdminRedis() });
      if (!result.ok) return c.json({ error: '用户不存在' }, 404);
      await recordTransaction(db, {
        userId: id,
        type: 'gift',
        amount: body.amount,
        balanceBefore: result.balanceBefore,
        balanceAfter: result.balanceAfter,
        refType: 'admin_gift',
        refId: adminId != null ? String(adminId) : undefined,
        remark: body.remark ?? '管理员赠送',
        createdBy: adminId ?? null,
      });
      await unfreezeIfBadDebt(db, id);
      await recordAudit(db, { adminId, action: 'user.gift', targetType: 'user', targetId: id, detail: { amount: body.amount } });
      return c.json({ ok: true, balanceBefore: result.balanceBefore, balanceAfter: result.balanceAfter });
    });
}
