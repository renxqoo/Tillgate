import { and, eq } from 'drizzle-orm';
import { users } from '@ai-gateway/db/schema';
import {
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
 * 流程：查本地账号 → 恒定时间密码校验（防枚举/防时序，用户不存在也跑等量 scrypt）
 *   → 密码错误才累计失败（正确密码豁免，防锁定 DoS）→ 状态检查 → 清零失败计数
 *   → 首登赠额（幂等，由 ledger 判定）→ 更新 last_login → 签发会话 JWT。
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

  const user = rows[0];
  // 恒定时间密码校验（01 修复）：用户不存在/哈希缺失也执行等量 scrypt（dummy hash），
  // 使「用户不存在」与「密码错」响应耗时一致，杜绝时序枚举。
  const passwordOk = await verifyPassword(input.password, user?.passwordHash ?? null);

  // 正确密码豁免（02 修复）：只有密码错误才累计失败并可能触发单源锁定；
  // 正确密码永远放行并清零计数，攻击者无法用错误密码锁死合法账号。
  if (!user || !passwordOk) {
    const throttle = await recordLoginFailure(s.redis, 'user', input.username, input.ip);
    if (throttle.locked) {
      return { kind: 'locked', retryAfterSec: throttle.retryAfterSec };
    }
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
