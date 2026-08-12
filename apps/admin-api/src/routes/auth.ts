import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { users, rateCards, rateCardCoefficients } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import { hashPassword } from '../lib/password.js';
import { recordAudit } from '../lib/audit.js';
import type { AdminEnv } from '@ai-gateway/identity';
import { z } from 'zod';
import { jsonBody } from '../lib/validation.js';

/**
 * 管理员开通本地用户账号（admin-api，set-password 段，从原 auth.ts 拆出）。
 *
 *   - POST /api/admin/users/:id/set-password：设置初始密码 + 绑定默认费率卡（仅管理员）
 *
 * 用户登录（login/logout/password）已迁 client-api（用户面）；管理员登录在 admin-auth.ts。
 *
 * 鉴权：由入口的 adminAuthMiddleware（/api/admin/*）+ adminIdInjector 守护，
 *      adminId 对应 admins.id。本端点不在 userSessionMiddleware 链路。
 */

const setPasswordSchema = z.object({
  password: z.string().min(8).max(128),
});

export function adminUserRoutes(db: Db): Hono<AdminEnv> {
  return new Hono<AdminEnv>()

    // 管理员开通本地账号（设置初始密码 + 绑定默认费率卡）
    .post('/api/admin/users/:id/set-password', jsonBody(setPasswordSchema), async (c) => {
      const adminId = c.get('adminId');
      // adminAuthMiddleware 已校验管理员身份并注入 adminId；此处防御性检查
      if (adminId === undefined) {
        return c.json({ error: { message: '需要管理员权限', code: 'FORBIDDEN' } }, 403);
      }
      const id = Number(c.req.param('id'));
      const body = c.req.valid('json');
      const hash = await hashPassword(body.password);
      const update: Record<string, unknown> = { passwordHash: hash, updatedAt: new Date() };
      // 若用户未绑费率卡，绑定默认「标准」卡（rate_cards.name='标准'）
      const cur = await db.select({ rateCardId: users.rateCardId }).from(users).where(eq(users.id, id)).limit(1);
      if (cur.length === 0) return c.json({ error: { message: '用户不存在', code: 'NOT_FOUND' } }, 404);
      if (cur[0]!.rateCardId === null) {
        const card = await db.select({ id: rateCards.id }).from(rateCards).where(eq(rateCards.name, '标准')).limit(1);
        if (card.length > 0) {
          update.rateCardId = card[0]!.id;
          // 确保 global 系数行存在（防御）
          const coeff = await db
            .select({ id: rateCardCoefficients.id })
            .from(rateCardCoefficients)
            .where(and(eq(rateCardCoefficients.rateCardId, card[0]!.id), eq(rateCardCoefficients.scope, 'global')))
            .limit(1);
          if (coeff.length === 0) {
            await db.insert(rateCardCoefficients).values({ rateCardId: card[0]!.id, scope: 'global', coefficient: '1.000' });
          }
        }
      }
      await db.update(users).set(update).where(eq(users.id, id));
      await recordAudit(db, { adminId, action: 'user.set_password', targetType: 'user', targetId: id });
      return c.json({ ok: true });
    });
}
