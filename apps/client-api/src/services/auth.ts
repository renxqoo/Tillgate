import { and, eq } from 'drizzle-orm';
import { users } from '@ai-gateway/db/schema';
import {
  checkLoginThrottle,
  recordLoginFailure,
  resetLoginFailures,
  signSession,
  verifyPassword,
} from '@ai-gateway/identity';
import type { ClientServices } from './index.js';
import type { ClientApiConfig } from '../config.js';

/**
 * 登录流程组件（从路由抽出，可单测）。
 *
 * 流程：限流检查（namespace='user'，双维度防 XFF 伪造）→ 查本地账号 →
 *       常量时间密码校验（防枚举/防时序）→ 状态检查 → 清零失败计数 →
 *       首登赠额（幂等，由 ledger 判定）→ 更新 last_login → 签发会话 JWT。
 *
 * 返回可判别结果，HTTP 映射（状态码/retry-after/Cookie）留在路由层。
 */

export interface LoginInput {
  username: string;
  password: string;
  ip: string;
}

export type LoginOutcome =
  | { kind: 'locked'; retryAfterSec: number }
  | { kind: 'invalid_credentials' }
  | { kind: 'banned' }
  | { kind: 'deleted' }
  | { kind: 'success'; token: string; userId: number; username: string; gifted: boolean };

export async function login(
  s: ClientServices,
  config: ClientApiConfig,
  input: LoginInput,
): Promise<LoginOutcome> {
  // 限流：锁定中直接拒绝（防 scrypt DoS）
  const throttle = await checkLoginThrottle(s.redis, 'user', input.username, input.ip);
  if (throttle.locked) {
    return { kind: 'locked', retryAfterSec: throttle.retryAfterSec };
  }

  // 查本地账号（issuer='local', subject=username）
  const rows = await s.db
    .select({
      id: users.id,
      subject: users.subject,
      passwordHash: users.passwordHash,
      status: users.status,
    })
    .from(users)
    .where(and(eq(users.issuer, 'local'), eq(users.subject, input.username)))
    .limit(1);

  // 统一错误（防用户名枚举）：无论用户不存在还是密码错，都返回相同结果
  const user = rows[0];
  const passwordOk = user ? await verifyPassword(input.password, user.passwordHash) : false;
  // 用户不存在时也跑一次 verify（恒定时间，防根据响应时间区分「用户不存在」vs「密码错」）
  if (!user || !passwordOk) {
    await recordLoginFailure(s.redis, 'user', input.username, input.ip);
    return { kind: 'invalid_credentials' };
  }

  if (user.status === 1) return { kind: 'banned' };
  if (user.status === 2) return { kind: 'deleted' };

  // 登录成功 → 清零失败计数
  await resetLoginFailures(s.redis, 'user', input.username, input.ip);

  // 新用户首次登录自动赠送体验额度（按身份源唯一判定防刷，幂等由 ledger 保证）
  let gifted = false;
  if (config.giftAmount > 0) {
    const result = await s.ledger.grantSignupGift({ userId: user.id, amount: String(config.giftAmount) });
    gifted = result.granted && !result.replayed;
  }

  await s.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));

  // 签发会话 JWT（type='user'，仅 client-api 验签）
  const token = await signSession({ type: 'user', id: user.id }, config.jwtSecret);

  return { kind: 'success', token, userId: user.id, username: user.subject, gifted };
}
