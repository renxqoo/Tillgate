import type { Context } from 'hono';
import type { Redis } from 'ioredis';
import { getConnInfo } from '@hono/node-server/conninfo';
import { trustedClientIp } from '@ai-gateway/http';

/**
 * 鉴权失败来源限流（07 修复）：按「来源 IP」对鉴权失败计数，短窗口内超过阈值即锁定。
 *
 * 背景：gateway 的 RPM/TPM 限流在鉴权之后才生效，鉴权失败（无效 Key）走不到限流器；
 * 而 per-key 的 brute-force-guard 只按 keyHash 计数（换随机 Key 即绕过），攻击者可用
 * 海量随机 Key 从同一来源无限刷 401（打爆 request_logs + Redis 键空间）。
 *
 * 本组件独立于 per-key 爆破防护：
 *   - per-key guard：保护「单个 Key」不被爆破（维度=keyHash）
 *   - 本 guard：保护「gateway 整体」不被单来源无差别刷鉴权失败（维度=来源 IP）
 */

export interface AuthFailurePolicy {
  /** 窗口内允许的最大鉴权失败次数 */
  limit: number;
  /** 失败计数窗口 / 锁定时长（秒） */
  windowS: number;
}

export interface AuthFailureCheck {
  limited: boolean;
  retryAfterSec: number;
}

const failKey = (ip: string) => `authfail:ip:${ip}`;
const lockKey = (ip: string) => `authfail:ip:lock:${ip}`;

export interface AuthFailureGuard {
  /** 是否已被锁定（请求前调用，避免对锁定来源继续查 DB） */
  isLocked(ip: string): Promise<AuthFailureCheck>;
  /** 记录一次鉴权失败；达阈值即锁定 */
  recordFailure(ip: string): Promise<AuthFailureCheck>;
}

export function createAuthFailureGuard(
  redis: Redis,
  policy: AuthFailurePolicy,
): AuthFailureGuard {
  return {
    async isLocked(ip) {
      try {
        const ttl = await redis.ttl(lockKey(ip));
        if (ttl > 0) return { limited: true, retryAfterSec: ttl };
      } catch {
        // Redis 不可用：fail-open
      }
      return { limited: false, retryAfterSec: 0 };
    },

    async recordFailure(ip) {
      try {
        const key = failKey(ip);
        const n = await redis.incr(key);
        if (n === 1) await redis.expire(key, policy.windowS);
        if (n >= policy.limit) {
          await redis.set(lockKey(ip), '1', 'EX', policy.windowS);
          return { limited: true, retryAfterSec: policy.windowS };
        }
        return { limited: false, retryAfterSec: 0 };
      } catch {
        // Redis 不可用：fail-open（不阻塞鉴权，仅失去限流保护）
        return { limited: false, retryAfterSec: 0 };
      }
    },
  };
}

/**
 * 提取来源 IP（可信代理语义，单一实现在 @ai-gateway/http trustedClientIp）。
 * trustedProxyHops=0（默认）：XFF/X-Real-IP 整体不信任（首段可伪造），只用 socket 地址；
 * hops=N（反向代理后）：取 XFF 右数第 N 跳——客户端伪造的首段被结构性丢弃。
 */
export function sourceIp(c: Context, trustedProxyHops = 0): string {
  let socketAddress: string | null = null;
  try {
    socketAddress = getConnInfo(c).remote?.address ?? null;
  } catch {
    // 测试环境 app.request() 无 socket 连接
  }
  return trustedClientIp({ headers: c.req.raw.headers, trustedProxyHops, socketAddress });
}
