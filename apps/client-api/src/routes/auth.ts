import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { setCookie, deleteCookie } from 'hono/cookie';
import { users, transactions } from '@ai-gateway/db/schema';
import { Decimal } from '@ai-gateway/money';
import type { Db } from '@ai-gateway/db';
import type { Redis } from 'ioredis';
import { sql } from 'drizzle-orm';
import { jsonBody } from '../lib/validation.js';
import { z } from 'zod';
import {
  signSession,
  verifyPassword,
  hashPassword,
  SESSION_COOKIE,
  SESSION_DEFAULT_TTL_S,
  cookieOptions,
  checkLoginThrottle,
  recordLoginFailure,
  resetLoginFailures,
  clientIp,
  type ClientEnv,
} from '@ai-gateway/identity';
import { recordAudit, unfreezeIfBadDebt } from '@ai-gateway/billing';

/**
 * 用户面会话与登录（client-api，api-contract §4.1 / §5）。
 *
 *   - POST /api/auth/login：本地账号（用户名 + 密码）
 *     · 本地账号由管理员开通（非自助注册）
 *     · 登录成功 → 签发 HttpOnly Cookie 会话 JWT（24h，type='user'）
 *     · 新用户首次登录自动赠送体验额度（¥1，按身份源唯一判定防刷）
 *
 *   - POST /api/auth/logout：清 Cookie
 *
 *   - POST /api/auth/password：修改自己的密码（已登录用户）
 *
 * 安全：
 *   - 密码用 scrypt 哈希校验（timingSafeEqual 常量时间比较）
 *   - 失败统一返回「用户名或密码错误」（不区分用户名是否存在，防枚举）
 *   - 登录成功更新 last_login_at
 *   - 登录限流（namespace='user'，与管理员锁定键空间隔离）
 *
 * 拆分后：login 签发的 JWT type='user'，仅 client-api 验签；管理员登录在 admin-api 独立端点。
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

export function clientAuthRoutes(
  db: Db,
  opts: { jwtSecret: string; giftAmount: number; secureCookie: boolean; redis?: Redis },
): Hono<ClientEnv> {
  const redis = opts.redis;
  return new Hono<ClientEnv>()

    // 登录
    .post('/api/auth/login', jsonBody(loginSchema), async (c) => {
      const body = c.req.valid('json');
      const ip = clientIp(c.req.raw.headers);

      // C6 修复：登录限流——锁定中直接拒绝（防 scrypt DoS）
      if (redis) {
        const throttle = await checkLoginThrottle(redis, 'user', body.username, ip);
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
          status: users.status,
          balance: users.balance,
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
        if (redis) await recordLoginFailure(redis, 'user', body.username, ip);
        return c.json({ error: { message: '用户名或密码错误', code: 'INVALID_CREDENTIALS' } }, 401);
      }

      // 状态校验
      if (user.status === 1) return c.json({ error: { message: '账号已封禁', code: 'ACCOUNT_BANNED' } }, 403);
      if (user.status === 2) return c.json({ error: { message: '账号已注销', code: 'ACCOUNT_DELETED' } }, 403);

      // C6 修复：登录成功 → 清零失败计数
      if (redis) await resetLoginFailures(redis, 'user', body.username, ip);

      // 首次登录赠送（余额为 0 且无任何流水 = 新用户）
      // #6 修复：原子条件 UPDATE（WHERE balance = 0）防并发首次登录双倍赠送
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

      // 签发会话 JWT（type='user'，仅 client-api 验签）
      const token = await signSession({ type: 'user', id: user.id }, opts.jwtSecret);
      setCookie(c, SESSION_COOKIE, token, cookieOptions(opts.secureCookie, SESSION_DEFAULT_TTL_S));

      return c.json({
        ok: true,
        user: {
          id: user.id,
          username: user.subject,
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
        adminId: null,
        action: 'user.password_change',
        targetType: 'user',
        targetId: session.userId,
      });
      return c.json({ ok: true });
    });
}
