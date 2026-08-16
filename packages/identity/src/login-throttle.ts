import { Redis } from 'ioredis';
import { trustedClientIp } from '@ai-gateway/http';

/**
 * 登录限流/锁定（02 修复，client-api 与 admin-api 共用）。
 *
 * 安全模型（修复「任意账号可被匿名锁死」的 DoS）：
 *   - 硬锁只绑定「(identifier, ip)」这一维度：攻击者只能锁死「自己来源 + 某账号」的
 *     组合，无法把目标账号全局锁死（受害者换 IP 或正确密码仍可登录）。
 *   - identifier-only 维度降级为「分布式爆破观测信号」：仅计数、绝不锁定。
 *     真正拦截分布式爆破靠「正确密码豁免 + 单源硬锁 + 更高层安全告警」，而非锁死账号。
 *   - 正确密码豁免：登录流程先做恒定时间校验，密码正确即清零并放行，
 *     攻击者无法用「错误密码」锁死「知道密码」的合法用户。
 *   - Redis 不可用 → fail-open（不阻塞登录，但记日志）。
 *
 * namespace：区分「用户登录」与「管理员登录」的锁定键空间。
 *   用户登录用 'user'，管理员登录用 'admin'，避免用户名与管理员邮箱撞车时计数互相污染。
 */

/** 单源（identifier, ip）连续失败阈值 */
export const LOGIN_FAIL_THRESHOLD = 5;
/** 失败计数窗口（秒） */
export const LOGIN_FAIL_WINDOW_S = 600; // 10 分钟
/** 单源锁定时长（秒） */
export const LOGIN_LOCK_DURATION_S = 600; // 10 分钟
/** identifier-only 分布式信号阈值（仅观测/告警，不锁定） */
export const LOGIN_DISTRIBUTED_SIGNAL_THRESHOLD = 100;

const failKey = (ns: string, identifier: string, ip: string) =>
  `login:fails:${ns}:${identifier}:${ip}`;
const lockKey = (ns: string, identifier: string, ip: string) =>
  `login:lock:${ns}:${identifier}:${ip}`;
/** identifier-only 维度（仅计数，不产生 lock key） */
const failKeyId = (ns: string, identifier: string) => `login:fails:${ns}:id:${identifier}`;

export interface ThrottleCheck {
  locked: boolean;
  retryAfterSec: number;
}

/**
 * 记录一次失败（登录失败后调用）。单源达阈值即锁定，返回锁定状态供调用方映射 429。
 * 同时递增 identifier-only 计数作为分布式爆破观测信号（不锁定）。
 */
export async function recordLoginFailure(
  redis: Redis,
  ns: string,
  identifier: string,
  ip: string,
): Promise<ThrottleCheck> {
  try {
    // (identifier, ip) 维度：唯一会产生硬锁的维度
    const key = failKey(ns, identifier, ip);
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, LOGIN_FAIL_WINDOW_S);
    let locked = false;
    let retryAfterSec = 0;
    if (n >= LOGIN_FAIL_THRESHOLD) {
      await redis.set(lockKey(ns, identifier, ip), '1', 'EX', LOGIN_LOCK_DURATION_S);
      locked = true;
      retryAfterSec = LOGIN_LOCK_DURATION_S;
    }
    // identifier-only 维度：仅计数（供监控/告警识别分布式爆破），绝不锁定账号。
    const keyId = failKeyId(ns, identifier);
    const nu = await redis.incr(keyId);
    if (nu === 1) await redis.expire(keyId, LOGIN_FAIL_WINDOW_S);
    return { locked, retryAfterSec };
  } catch {
    // Redis 不可用：fail-open（记日志由调用方处理）
    return { locked: false, retryAfterSec: 0 };
  }
}

/** 清零失败计数与锁（登录成功后调用）—— 清两个维度 */
export async function resetLoginFailures(
  redis: Redis,
  ns: string,
  identifier: string,
  ip: string,
): Promise<void> {
  try {
    await redis.del(failKey(ns, identifier, ip), lockKey(ns, identifier, ip));
    await redis.del(failKeyId(ns, identifier));
  } catch {
    // Redis 不可用：忽略（TTL 兜底）
  }
}

/**
 * 提取客户端 IP（可信代理语义，单一实现在 @ai-gateway/http trustedClientIp）：
 * trustedProxyHops=0（默认）完全不信任 XFF/X-Real-IP（可伪造），只用 socket 地址；
 * hops=N 取 XFF 右数第 N 跳（我们信任的第一层代理看到的客户端 IP）。
 * 客户端伪造 XFF 首段的攻击在 hops>0 时被结构性丢弃；hops=0 时头整体被忽略。
 */
export function clientIp(
  headers: Headers,
  opts: { trustedProxyHops: number; socketAddress?: string | null; fallbackRemote?: string } = { trustedProxyHops: 0 },
): string {
  return trustedClientIp({ headers, trustedProxyHops: opts.trustedProxyHops, socketAddress: opts.socketAddress });
}
