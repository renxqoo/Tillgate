import { Redis } from 'ioredis';

/**
 * C6 修复：控制台登录限流/锁定。
 *
 * 背景：/api/auth/login 原本无限流，scrypt verifyPassword 可被放大 DoS。
 * gateway 的静态 Key 鉴权有 brute-force-guard（5 次锁 10 分钟），admin 登录没有。
 *
 * 策略（与 gateway brute-force-guard 对齐）：
 *   - 双维度计数：(username, ip) 防 单IP爆破 + username-only 防分布式爆破
 *   - username-only 维度不可被 XFF 伪造绕过（username 是登录目标，攻击者无法改）
 *   - 任一维度连续失败达阈值（5）→ 锁定 10 分钟
 *   - 成功登录 → 清零两个维度的计数
 *   - Redis 不可用 → fail-open（不阻塞登录，但记日志）
 *
 * 共享 admin-api 的 Redis 单例（与 route-invalidation 同源）。
 */

/** 阈值：连续失败 N 次触发锁定 */
export const LOGIN_FAIL_THRESHOLD = 5;
/** 失败计数窗口（秒） */
export const LOGIN_FAIL_WINDOW_S = 600; // 10 分钟
/** 锁定时长（秒） */
export const LOGIN_LOCK_DURATION_S = 600; // 10 分钟

const failKey = (username: string, ip: string) => `login:fails:${username}:${ip}`;
const lockKey = (username: string, ip: string) => `login:lock:${username}:${ip}`;
/** username-only 维度（防 XFF 伪造绕过：攻击者换 IP 但 username 固定） */
const failKeyUser = (username: string) => `login:fails:user:${username}`;
const lockKeyUser = (username: string) => `login:lock:user:${username}`;

export interface ThrottleCheck {
  locked: boolean;
  retryAfterSec: number;
}

/** 检查是否被锁定（登录前调用）—— 双维度：任一锁定即拒绝 */
export async function checkLoginThrottle(redis: Redis, username: string, ip: string): Promise<ThrottleCheck> {
  try {
    // username-only 维度（不可伪造，优先查）
    const ttlUser = await redis.ttl(lockKeyUser(username));
    if (ttlUser > 0) return { locked: true, retryAfterSec: ttlUser };
    // (username, ip) 维度
    const ttl = await redis.ttl(lockKey(username, ip));
    if (ttl > 0) return { locked: true, retryAfterSec: ttl };
  } catch {
    // Redis 不可用：fail-open
  }
  return { locked: false, retryAfterSec: 0 };
}

/** 记录一次失败（登录失败后调用）；任一维度达阈值则锁定 */
export async function recordLoginFailure(redis: Redis, username: string, ip: string): Promise<void> {
  try {
    // (username, ip) 维度
    const key = failKey(username, ip);
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, LOGIN_FAIL_WINDOW_S);
    if (n >= LOGIN_FAIL_THRESHOLD) {
      await redis.set(lockKey(username, ip), '1', 'EX', LOGIN_LOCK_DURATION_S);
    }
    // username-only 维度（防 XFF 伪造：换 IP 也累计）
    const keyUser = failKeyUser(username);
    const nu = await redis.incr(keyUser);
    if (nu === 1) await redis.expire(keyUser, LOGIN_FAIL_WINDOW_S);
    if (nu >= LOGIN_FAIL_THRESHOLD) {
      await redis.set(lockKeyUser(username), '1', 'EX', LOGIN_LOCK_DURATION_S);
    }
  } catch {
    // Redis 不可用：fail-open（记日志由调用方处理）
  }
}

/** 清零失败计数（登录成功后调用）—— 清两个维度 */
export async function resetLoginFailures(redis: Redis, username: string, ip: string): Promise<void> {
  try {
    await redis.del(failKey(username, ip), lockKey(username, ip));
    await redis.del(failKeyUser(username), lockKeyUser(username));
  } catch {
    // Redis 不可用：忽略（TTL 兜底）
  }
}

/** 提取客户端 IP（优先 X-Forwarded-For 首段，fallback socket） */
export function clientIp(headers: Headers, fallbackRemote = 'unknown'): string {
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const realIp = headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  return fallbackRemote;
}
