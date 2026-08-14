import type { Context } from 'hono';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';

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

export class AuthFailureGuard {
  constructor(
    private readonly redis: Redis,
    private readonly policy: AuthFailurePolicy,
  ) {}

  /** 是否已被锁定（请求前调用，避免对锁定来源继续查 DB） */
  async isLocked(ip: string): Promise<AuthFailureCheck> {
    try {
      const ttl = await this.redis.ttl(lockKey(ip));
      if (ttl > 0) return { limited: true, retryAfterSec: ttl };
    } catch {
      // Redis 不可用：fail-open
    }
    return { limited: false, retryAfterSec: 0 };
  }

  /** 记录一次鉴权失败；达阈值即锁定 */
  async recordFailure(ip: string): Promise<AuthFailureCheck> {
    try {
      const key = failKey(ip);
      const n = await this.redis.incr(key);
      if (n === 1) await this.redis.expire(key, this.policy.windowS);
      if (n >= this.policy.limit) {
        await this.redis.set(lockKey(ip), '1', 'EX', this.policy.windowS);
        return { limited: true, retryAfterSec: this.policy.windowS };
      }
      return { limited: false, retryAfterSec: 0 };
    } catch {
      // Redis 不可用：fail-open（不阻塞鉴权，仅失去限流保护）
      return { limited: false, retryAfterSec: 0 };
    }
  }
}

/**
 * 提取来源 IP（优先 X-Forwarded-For 首段，其次 X-Real-IP，最后 socket 地址）。
 * XFF/X-Real-IP 可被客户端伪造，但 socket 地址（getConnInfo）不可伪造；
 * 部署在反向代理后时以代理注入的 XFF 首段为准。
 */
export function sourceIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const realIp = c.req.header('x-real-ip');
  if (realIp && realIp.trim()) return realIp.trim();
  try {
    const info = getConnInfo(c);
    const addr = info?.remote?.address;
    if (addr) return addr;
  } catch {
    // 测试环境 app.request() 无 socket 连接
  }
  // 无 socket（测试/极端环境）时用进程级唯一值兜底，避免多个测试 worker 共享 'unknown'
  // 导致鉴权失败计数互相污染（测试隔离）。
  processFallbackIp ??= `unknown-${randomUUID()}`;
  return processFallbackIp;
}

let processFallbackIp: string | null = null;
