import { Redis } from 'ioredis';

/**
 * 登录限流/锁定（C6 修复，client-api 与 admin-api 共用）。
 *
 * 背景：登录端点原本无限流，scrypt verifyPassword 可被放大 DoS。
 *
 * 策略（与 gateway brute-force-guard 对齐）：
 *   - 双维度计数：(identifier, ip) 防 单IP爆破 + identifier-only 防分布式爆破
 *   - identifier-only 维度不可被 XFF 伪造绕过（登录目标固定，攻击者无法改）
 *   - 任一维度连续失败达阈值（5）→ 锁定 10 分钟
 *   - 成功登录 → 清零两个维度的计数
 *   - Redis 不可用 → fail-open（不阻塞登录，但记日志）
 *
 * namespace：区分「用户登录」与「管理员登录」的锁定键空间。
 *   用户登录用 'user'，管理员登录用 'admin'，避免用户名与管理员邮箱撞车时计数互相污染。
 */

/** 阈值：连续失败 N 次触发锁定 */
export const LOGIN_FAIL_THRESHOLD = 5;
/** 失败计数窗口（秒） */
export const LOGIN_FAIL_WINDOW_S = 600; // 10 分钟
/** 锁定时长（秒） */
export const LOGIN_LOCK_DURATION_S = 600; // 10 分钟

const failKey = (ns: string, identifier: string, ip: string) => `login:fails:${ns}:${identifier}:${ip}`;
const lockKey = (ns: string, identifier: string, ip: string) => `login:lock:${ns}:${identifier}:${ip}`;
/** identifier-only 维度（防 XFF 伪造绕过：攻击者换 IP 但 identifier 固定） */
const failKeyId = (ns: string, identifier: string) => `login:fails:${ns}:id:${identifier}`;
const lockKeyId = (ns: string, identifier: string) => `login:lock:${ns}:id:${identifier}`;

export interface ThrottleCheck {
  locked: boolean;
  retryAfterSec: number;
}

/**
 * 检查是否被锁定（登录前调用）—— 双维度：任一锁定即拒绝。
 *   ns: 身份命名空间（'user' / 'admin'）
 *   identifier: 登录目标（用户 username / 管理员 email）
 */
export async function checkLoginThrottle(
  redis: Redis,
  ns: string,
  identifier: string,
  ip: string,
): Promise<ThrottleCheck> {
  try {
    // identifier-only 维度（不可伪造，优先查）
    const ttlId = await redis.ttl(lockKeyId(ns, identifier));
    if (ttlId > 0) return { locked: true, retryAfterSec: ttlId };
    // (identifier, ip) 维度
    const ttl = await redis.ttl(lockKey(ns, identifier, ip));
    if (ttl > 0) return { locked: true, retryAfterSec: ttl };
  } catch {
    // Redis 不可用：fail-open
  }
  return { locked: false, retryAfterSec: 0 };
}

/** 记录一次失败（登录失败后调用）；任一维度达阈值则锁定 */
export async function recordLoginFailure(
  redis: Redis,
  ns: string,
  identifier: string,
  ip: string,
): Promise<void> {
  try {
    // (identifier, ip) 维度
    const key = failKey(ns, identifier, ip);
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, LOGIN_FAIL_WINDOW_S);
    if (n >= LOGIN_FAIL_THRESHOLD) {
      await redis.set(lockKey(ns, identifier, ip), '1', 'EX', LOGIN_LOCK_DURATION_S);
    }
    // identifier-only 维度（防 XFF 伪造：换 IP 也累计）
    const keyId = failKeyId(ns, identifier);
    const nu = await redis.incr(keyId);
    if (nu === 1) await redis.expire(keyId, LOGIN_FAIL_WINDOW_S);
    if (nu >= LOGIN_FAIL_THRESHOLD) {
      await redis.set(lockKeyId(ns, identifier), '1', 'EX', LOGIN_LOCK_DURATION_S);
    }
  } catch {
    // Redis 不可用：fail-open（记日志由调用方处理）
  }
}

/** 清零失败计数（登录成功后调用）—— 清两个维度 */
export async function resetLoginFailures(
  redis: Redis,
  ns: string,
  identifier: string,
  ip: string,
): Promise<void> {
  try {
    await redis.del(failKey(ns, identifier, ip), lockKey(ns, identifier, ip));
    await redis.del(failKeyId(ns, identifier), lockKeyId(ns, identifier));
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
