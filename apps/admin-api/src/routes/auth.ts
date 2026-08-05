import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { setCookie, deleteCookie } from 'hono/cookie';
import { users, rateCards, rateCardCoefficients, transactions } from '@ai-gateway/db/schema';
import { Decimal } from '@ai-gateway/money';
import type { Db } from '@ai-gateway/db';
import type { Redis } from 'ioredis';
import { sql } from 'drizzle-orm';
import { jsonBody } from '../lib/validation.js';
import { z } from 'zod';
import { verifyPassword, hashPassword } from '../lib/password.js';
import { signSession, SESSION_COOKIE, SESSION_DEFAULT_TTL_S } from '../lib/session.js';
import { recordAudit } from '../lib/audit.js';
import { unfreezeIfBadDebt } from '../lib/balance.js';
import type { AdminEnv } from '../middleware/session.js';
import {
  checkLoginThrottle,
  recordLoginFailure,
  resetLoginFailures,
  clientIp,
} from '../lib/login-throttle.js';

/**
 * 控制台会话与登录（api-contract §4.1 / §5）。
 *
 *   - POST /api/auth/login：本地账号（用户名 + 密码）
 *     · 一期本地账号由管理员开通（非自助注册，requirements 4.1）
 *     · 登录成功 → 签发 HttpOnly Cookie 会话 JWT（24h）
 *     · 新用户首次登录自动赠送体验额度（requirements 4.1：¥1，按身份源唯一判定防刷）
 *
 *   - POST /api/auth/logout：清 Cookie
 *
 *   - POST /api/auth/password：修改自己的密码（已登录用户）
 *
 * 安全：
 *   - 密码用 scrypt 哈希校验（timingSafeEqual 常量时间比较）
 *   - 失败统一返回「用户名或密码错误」（不区分用户名是否存在，防枚举）
 *   - 登录成功更新 last_login_at
 */

const loginSchema = z.object({
  /** 本地账号：subject（用户名）；issuer 固定 'local' */
  username: z.string().min(1).max(255),
  password: z.string().min(1).max(256),
});

const passwordChangeSchema = z.object({
  oldPassword: z.string().min(1).max(256),
  newPassword: z.string().min(8).max(128),
});

/** Cookie 安全属性（生产 https 才开 secure） */
function cookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_DEFAULT_TTL_S,
  };
}

export function authRoutes(db: Db, opts: { jwtSecret: string; giftAmount: number; secureCookie: boolean; redis?: Redis }): Hono<AdminEnv> {
  const redis = opts.redis;
  return new Hono<AdminEnv>()

    // 登录
    .post('/api/auth/login', jsonBody(loginSchema), async (c) => {
      const body = c.req.valid('json');
      const ip = clientIp(c.req.raw.headers);

      // C6 修复：登录限流——锁定中直接拒绝（防 scrypt DoS）
      if (redis) {
        const throttle = await checkLoginThrottle(redis, body.username, ip);
        if (throttle.locked) {
          c.header('retry-after', String(throttle.retryAfterSec));
          return c.json(
            { error: { message: '登录尝试过多，已临时锁定', code: 'TOO_MANY_ATTEMPTS' } },
            429,
          );
        }
      }

      // 查本地账号（issuer='local', subject=username）
      const rows = await db
        .select({
          id: users.id,
          subject: users.subject,
          passwordHash: users.passwordHash,
          role: users.role,
          status: users.status,
          balance: users.balance,
          rateCardId: users.rateCardId,
        })
        .from(users)
        .where(and(eq(users.issuer, 'local'), eq(users.subject, body.username)))
        .limit(1);

      // 统一错误（防用户名枚举）：无论用户不存在还是密码错，都返回相同消息 + 相同延迟
      const user = rows[0];
      const passwordOk = user ? await verifyPassword(body.password, user.passwordHash) : false;
      // 用户不存在时也跑一次 verify（恒定时间，防根据响应时间区分「用户不存在」vs「密码错」）
      if (!user || !passwordOk) {
        // C6 修复：记录失败（达阈值锁定）
        if (redis) await recordLoginFailure(redis, body.username, ip);
        return c.json({ error: { message: '用户名或密码错误', code: 'INVALID_CREDENTIALS' } }, 401);
      }

      // 状态校验
      if (user.status === 1) return c.json({ error: { message: '账号已封禁', code: 'ACCOUNT_BANNED' } }, 403);
      if (user.status === 2) return c.json({ error: { message: '账号已注销', code: 'ACCOUNT_DELETED' } }, 403);

      // C6 修复：登录成功 → 清零失败计数
      if (redis) await resetLoginFailures(redis, body.username, ip);

      // 首次登录赠送（余额为 0 且无任何流水 = 新用户）
      // #6 修复：原子条件 UPDATE（WHERE balance = 0）防并发首次登录双倍赠送
      // 旧实现 balance===0 + txCount===0 检查非原子，两个并发请求都能通过 → 各加一次 gift
      let gifted = false;
      const giftAmountStr = String(opts.giftAmount);
      // 用 Decimal 判余额为 0（DB numeric 返回 '0.000...' 带尾随零，严格 === 不匹配）
      if (opts.giftAmount > 0 && new Decimal(user.balance).isZero()) {
        const txCount = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(transactions)
          .where(eq(transactions.userId, user.id));
        if (Number(txCount[0]?.count ?? 0) === 0) {
          // 赠送体验额度（原子条件 UPDATE：仅 balance=0 时加，防并发双花）
          const result = await db.transaction(async (tx) => {
            const updated = await tx
              .update(users)
              .set({ balance: sql`${users.balance} + ${giftAmountStr}::numeric`, updatedAt: new Date() })
              .where(sql`${users.id} = ${user.id} and ${users.balance} = 0`)
              .returning({ balance: users.balance });
            if (updated.length === 0) return null; // 并发竞态：已被另一个请求赠送，跳过
            const after = updated[0]!.balance;
            await tx.insert(transactions).values({
              userId: user.id,
              type: 'gift',
              amount: giftAmountStr,
              balanceBefore: '0',
              balanceAfter: after,
              refType: 'signup_gift',
              refId: `gift:${user.id}`,
              remark: `新用户赠送 ${giftAmountStr}`,
            }).onConflictDoNothing({
              target: [transactions.refType, transactions.refId],
              where: sql`ref_type = 'signup_gift'`,
            });
            return after;
          });
          if (result !== null) {
            gifted = true;
          }
          await unfreezeIfBadDebt(db, user.id).catch(() => {});
          await recordAudit(db, {
            adminId: null,
            actor: 'system',
            action: 'user.signup_gift',
            targetType: 'user',
            targetId: user.id,
            detail: { amount: opts.giftAmount },
          });
        }
      }

      // 更新 last_login_at
      await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));

      // 签发会话 JWT
      const token = await signSession({ userId: user.id, role: user.role }, opts.jwtSecret);
      setCookie(c, SESSION_COOKIE, token, cookieOptions(opts.secureCookie));

      return c.json({
        ok: true,
        user: {
          id: user.id,
          username: user.subject,
          role: user.role,
          gifted,
        },
      });
    })

    // 注销
    .post('/api/auth/logout', (c) => {
      deleteCookie(c, SESSION_COOKIE, { path: '/' });
      return c.json({ ok: true });
    })

    // 修改密码（需已登录）
    .post('/api/auth/password', jsonBody(passwordChangeSchema), async (c) => {
      const session = c.get('session');
      if (!session) return c.json({ error: { message: '未登录', code: 'UNAUTHORIZED' } }, 401);
      const body = c.req.valid('json');

      const rows = await db
        .select({ id: users.id, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, session.userId))
        .limit(1);
      if (rows.length === 0) return c.json({ error: { message: '用户不存在', code: 'NOT_FOUND' } }, 404);
      const u = rows[0]!;

      const ok = await verifyPassword(body.oldPassword, u.passwordHash);
      if (!ok) return c.json({ error: { message: '原密码错误', code: 'INVALID_CREDENTIALS' } }, 401);

      const newHash = await hashPassword(body.newPassword);
      await db.update(users).set({ passwordHash: newHash, updatedAt: new Date() }).where(eq(users.id, u.id));
      await recordAudit(db, {
        adminId: session.userId,
        action: 'user.password_change',
        targetType: 'user',
        targetId: session.userId,
      });
      return c.json({ ok: true });
    })

    // 管理员开通本地账号（仅 role=1）：设置初始密码 + 绑定默认费率卡
    // 鉴权断链修复：原实现读 c.get('session')，但 session 仅由 userSessionMiddleware 注入，
    // 而它只挂 /api/me/*、/api/keys/* 等，未挂 /api/admin/*。/api/admin/* 链路只有
    // adminIdInjector 注入的 adminId（role=1 时为 userId，否则 undefined）。改用 adminId：
    // 既满足管理员判定（!=undefined 等价于 role=1），又取到操作人 userId 供审计。
    .post('/api/admin/users/:id/set-password', async (c) => {
      const adminId = c.get('adminId');
      if (adminId === undefined) {
        return c.json({ error: { message: '需要管理员权限', code: 'FORBIDDEN' } }, 403);
      }
      const id = Number(c.req.param('id'));
      const body = (await c.req.json().catch(() => ({}))) as { password?: string };
      if (!body.password || body.password.length < 8) {
        return c.json({ error: { message: '密码至少 8 位', code: 'VALIDATION_ERROR' } }, 400);
      }
      const hash = await hashPassword(body.password);
      const update: Record<string, unknown> = { passwordHash: hash, updatedAt: new Date() };
      // 若用户未绑费率卡，绑定默认「标准」卡（rate_cards.name='标准'）
      const cur = await db.select({ rateCardId: users.rateCardId }).from(users).where(eq(users.id, id)).limit(1);
      if (cur.length === 0) return c.json({ error: '用户不存在' }, 404);
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
