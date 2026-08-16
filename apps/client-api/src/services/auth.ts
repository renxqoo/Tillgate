import { and, eq } from 'drizzle-orm';
import { randomBytes, randomInt } from 'node:crypto';
import { pgSqlState } from '@ai-gateway/http';
import { users } from '@ai-gateway/db/schema';
import {
  hashPassword,
  recordLoginFailure,
  resetLoginFailures,
  signSession,
  verifyPassword,
  issueLoginCodeChallenge,
  abortLoginCodeChallenge,
  verifyLoginCodeChallenge,
  LoginCodeCooldownError,
} from '@ai-gateway/identity';
import type { ClientServices } from './index.js';
import type { ClientApiConfig } from '../config.js';

/**
 * 登录流程组件（邮箱登录 + 强制邮箱验证码，两步）：
 *
 * 第一步 login()：查本地账号（email）→ 恒定时间密码校验（防枚举/防时序）
 *   → 密码错误才累计失败（正确密码豁免，防锁定 DoS）→ 状态检查 → 清零失败计数
 *   → 发 6 位验证码（60s 冷却/账号，5 分钟有效）→ 返回 challenge（不签会话）。
 *
 * 第二步 verifyLoginCode()：验码（错 5 次作废，一次性消费防重放）→ 状态复查
 *   → 首登赠额（幂等，由 ledger 判定）→ 更新 last_login → 签发会话 JWT。
 *
 * 返回可判别结果，HTTP 映射（状态码/retry-after/Cookie）留在路由层。
 */

export interface LoginInput {
  email: string;
  password: string;
  ip: string;
}

export type LoginOutcome =
  | { kind: 'locked'; retryAfterSec: number }
  | { kind: 'invalid_credentials' }
  | { kind: 'banned' }
  | { kind: 'deleted' }
  | { kind: 'mailer_unavailable' }
  | { kind: 'code_rate_limited'; retryAfterSec: number }
  | { kind: 'code_send_failed' }
  | { kind: 'code_required'; challengeId: string };

export async function login(
  s: ClientServices,
  config: ClientApiConfig,
  input: LoginInput,
): Promise<LoginOutcome> {
  const email = input.email.trim().toLowerCase();

  // 查本地账号（issuer='local'，email 唯一索引 users_local_email_uq）
  const rows = await s.db
    .select({
      id: users.id,
      email: users.email,
      passwordHash: users.passwordHash,
      status: users.status,
    })
    .from(users)
    .where(and(eq(users.issuer, 'local'), eq(users.email, email)))
    .limit(1);

  const user = rows[0];
  // 恒定时间密码校验）：用户不存在/哈希缺失也执行等量 scrypt（dummy hash），
  // 使「用户不存在」与「密码错」响应耗时一致，杜绝时序枚举。
  const passwordOk = await verifyPassword(input.password, user?.passwordHash ?? null);

  // 正确密码豁免：只有密码错误才累计失败并可能触发单源锁定；
  // 正确密码永远放行并清零计数，攻击者无法用错误密码锁死合法账号。
  if (!user || !passwordOk) {
    const throttle = await recordLoginFailure(s.redis, 'user', email, input.ip);
    if (throttle.locked) {
      return { kind: 'locked', retryAfterSec: throttle.retryAfterSec };
    }
    return { kind: 'invalid_credentials' };
  }

  if (user.status === 1) return { kind: 'banned' };
  if (user.status === 2) return { kind: 'deleted' };

  // 密码正确 → 清零失败计数
  await resetLoginFailures(s.redis, 'user', email, input.ip);

  // 强制邮箱验证（fail-closed）：SMTP 未配置 → 503，绝不静默降级为单密码
  if (!s.mailer) return { kind: 'mailer_unavailable' };

  const code = String(randomInt(100000, 1000000));
  let challengeId: string;
  try {
    challengeId = await issueLoginCodeChallenge(s.redis, 'user', String(user.id), code);
  } catch (e) {
    if (e instanceof LoginCodeCooldownError) {
      return { kind: 'code_rate_limited', retryAfterSec: 60 };
    }
    throw e;
  }
  try {
    await s.mailer.sendLoginCode(user.email ?? email, code, { ip: input.ip });
  } catch {
    // 投递失败回滚挑战（冷却一并清除，用户可立即重试）
    await abortLoginCodeChallenge(s.redis, 'user', String(user.id), challengeId);
    return { kind: 'code_send_failed' };
  }

  return { kind: 'code_required', challengeId };
}

export type VerifyLoginCodeOutcome =
  | { kind: 'code_invalid' }
  | { kind: 'challenge_invalid' }
  | { kind: 'account_unavailable' }
  | { kind: 'success'; token: string; userId: number; email: string; gifted: boolean };

/** 新用户默认显示名：rx + 6 位随机（去易混字符）；用户可随时自助修改 */
export function defaultDisplayName(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(6);
  return 'rx' + [...bytes].map((b) => alphabet[b % alphabet.length]!).join('');
}

/** 验证通过后的会话签发（登录/注册/OAuth 共用）：赠额（幂等）+ lastLogin + JWT */
export async function issueSession(
  s: ClientServices,
  config: ClientApiConfig,
  userId: number,
): Promise<{ token: string; gifted: boolean }> {
  let gifted = false;
  if (config.giftAmount > 0) {
    const result = await s.ledger.grantSignupGift({
      userId,
      amount: String(config.giftAmount),
    });
    gifted = result.granted && !result.replayed;
  }
  await s.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
  const token = await signSession({ type: 'user', id: userId }, config.jwtSecret);
  return { token, gifted };
}

export async function verifyLoginCode(
  s: ClientServices,
  config: ClientApiConfig,
  input: { challengeId: string; code: string; ip: string },
): Promise<VerifyLoginCodeOutcome> {
  const outcome = await verifyLoginCodeChallenge(s.redis, 'user', input.challengeId, input.code);
  if (!outcome.ok) {
    if (outcome.reason === 'CODE_INVALID') return { kind: 'code_invalid' };
    return { kind: 'challenge_invalid' };
  }
  const userId = Number(outcome.subjectId);

  const rows = await s.db
    .select({
      id: users.id,
      email: users.email,
      status: users.status,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const user = rows[0];
  if (!user || user.status !== 0) return { kind: 'account_unavailable' };

  const session = await issueSession(s, config, user.id);
  return { kind: 'success', token: session.token, userId: user.id, email: user.email ?? '', gifted: session.gifted };
}

// ─────────────────────────────────────────────────────────────────────────────
// 邮箱自助注册（两步：注册 → 邮箱验证码 → 建号并自动登录）
// ─────────────────────────────────────────────────────────────────────────────

/** 同 IP 注册请求（含发码）上限/小时——防批量刷号 */
export const REGISTER_IP_LIMIT_PER_HOUR = 5;

export interface RegisterInput {
  email: string;
  password: string;
  ip: string;
  /** 浏览器 widget 产生的人机验证 token（启用 captcha 时必填） */
  captchaToken?: string;
  /** 可信服务间调用豁免（路由层已恒定时间校验 x-internal-token） */
  captchaExempt?: boolean;
}

export type RegisterOutcome =
  | { kind: 'rate_limited'; retryAfterSec: number }
  | { kind: 'captcha_required' }
  | { kind: 'captcha_invalid' }
  | { kind: 'captcha_unavailable' }
  | { kind: 'email_taken' }
  | { kind: 'mailer_unavailable' }
  | { kind: 'code_rate_limited'; retryAfterSec: number }
  | { kind: 'code_send_failed' }
  | { kind: 'code_required'; challengeId: string };

export async function register(
  s: ClientServices,
  _config: ClientApiConfig,
  input: RegisterInput,
): Promise<RegisterOutcome> {
  const email = input.email.trim().toLowerCase();

  // IP 限流（先记数再判断：每次请求都计入配额）
  const reqKey = `register:req:${input.ip}`;
  const n = await s.redis.incr(reqKey);
  if (n === 1) await s.redis.expire(reqKey, 3600);
  if (n > REGISTER_IP_LIMIT_PER_HOUR) {
    return { kind: 'rate_limited', retryAfterSec: 3600 };
  }

  // 人机验证门禁（位于 IP 限流之后：垃圾请求先吃便宜的 429，再谈验签）。
  // 厂商不可用 fail-closed——打瘫 Turnstile 不能换来自动放行。
  if (s.captcha && !input.captchaExempt) {
    const token = input.captchaToken?.trim();
    if (!token) return { kind: 'captcha_required' };
    const outcome = await s.captcha.verify({ token, remoteIp: input.ip });
    if (!outcome.ok) {
      return outcome.reason === 'unavailable' ? { kind: 'captcha_unavailable' } : { kind: 'captcha_invalid' };
    }
  }

  // 邮箱占用检查（DB 唯一索引 users_local_email_uq 兜底并发）
  const existing = await s.db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.issuer, 'local'), eq(users.email, email)))
    .limit(1);
  if (existing.length > 0) return { kind: 'email_taken' };

  // fail-closed：SMTP 未配置 → 503（与登录同口径）
  if (!s.mailer) return { kind: 'mailer_unavailable' };

  // 密码哈希在签发时计算并存入挑战（Redis 不落明文；验证通过直接用于建号）
  const code = String(randomInt(100000, 1000000));
  const passwordHash = await hashPassword(input.password);
  let challengeId: string;
  try {
    challengeId = await issueLoginCodeChallenge(s.redis, 'user', email, code, { passwordHash });
  } catch (e) {
    if (e instanceof LoginCodeCooldownError) {
      return { kind: 'code_rate_limited', retryAfterSec: 60 };
    }
    throw e;
  }
  try {
    await s.mailer.sendLoginCode(email, code, { ip: input.ip });
  } catch {
    await abortLoginCodeChallenge(s.redis, 'user', email, challengeId);
    return { kind: 'code_send_failed' };
  }

  return { kind: 'code_required', challengeId };
}

export type VerifyRegistrationOutcome =
  | { kind: 'code_invalid' }
  | { kind: 'challenge_invalid' }
  | { kind: 'email_taken' }
  | { kind: 'success'; token: string; userId: number; email: string; gifted: boolean };

export async function verifyRegistration(
  s: ClientServices,
  config: ClientApiConfig,
  input: { challengeId: string; code: string },
): Promise<VerifyRegistrationOutcome> {
  const outcome = await verifyLoginCodeChallenge(s.redis, 'user', input.challengeId, input.code);
  if (!outcome.ok) {
    if (outcome.reason === 'CODE_INVALID') return { kind: 'code_invalid' };
    return { kind: 'challenge_invalid' };
  }
  const email = outcome.subjectId.trim().toLowerCase();
  const passwordHash = outcome.data?.passwordHash;
  if (!passwordHash) return { kind: 'challenge_invalid' };

  try {
    const [created] = await s.db
      .insert(users)
      .values({
        issuer: 'local',
        subject: email,
        identityProvider: 'local',
        email,
        displayName: defaultDisplayName(),
        passwordHash,
      })
      .returning({ id: users.id, email: users.email });
    const session = await issueSession(s, config, created!.id);
    return {
      kind: 'success',
      token: session.token,
      userId: created!.id,
      email: created!.email ?? email,
      gifted: session.gifted,
    };
  } catch (e) {
    // 并发注册同一邮箱：唯一索引 users_local_email_uq 兜底 → 语义化 409
    if (e instanceof Error && pgSqlState(e) === '23505') return { kind: 'email_taken' };
    throw e;
  }
}
