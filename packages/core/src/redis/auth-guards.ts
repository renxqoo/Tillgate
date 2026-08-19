/**
 * 鉴权爆破防护（v1 两层语义的下沉移植）：
 *   - keyBruteForceGuard：保护「单个 Key」不被爆破（维度=keyHash：窗口内失败
 *     N 次锁 M 分钟，成功即清零）
 *   - authFailureGuard：保护「网关整体」不被单来源无差别刷鉴权失败（维度=来源
 *     IP——per-key 计数可被换随机 Key 绕过，攻击者可用海量随机 Key 打爆日志与键空间）
 *
 * 故障语义（Redis 是首选组件）：默认 fail-closed——存储不可用抛
 * AuthGuardUnavailableError，调用方拒绝鉴权（503）；显式 failMode:'open' 放行。
 * recordSuccess 恒 best-effort（成功路径的清理失败不反杀合法请求）。
 * keyHash/IP 的提取语义（可信代理跳数）由调用方注入。
 */
import type { Redis } from 'ioredis';

/** Redis 不可达时的防护错误（fail-closed 模式；调用方映射 503） */
export class AuthGuardUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`auth guard storage unavailable: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = 'AuthGuardUnavailableError';
  }
}

export interface GuardFailureMode {
  /** Redis 故障语义：closed（默认）= 抛错拒绝；open = 放行（仅失去防护） */
  failMode?: 'open' | 'closed';
}

export interface BruteForcePolicy {
  /** 窗口内连续失败阈值（达到即锁定） */
  failureThreshold: number;
  /** 失败计数窗口（秒） */
  failureWindowS: number;
  /** 锁定时长（秒） */
  lockS: number;
}

export interface GuardCheck {
  locked: boolean;
  retryAfterSec: number;
}

const failsKey = (keyHash: string) => `auth:fails:${keyHash}`;
const lockKey = (keyHash: string) => `auth:lock:${keyHash}`;

export interface KeyBruteForceGuard {
  /** 请求前：是否已锁定（锁存在或失败计数达阈值） */
  isLocked(keyHash: string): Promise<GuardCheck>;
  /** 记录一次失败；达阈值即锁 */
  recordFailure(keyHash: string): Promise<GuardCheck>;
  /** 认证成功：清零计数与锁 */
  recordSuccess(keyHash: string): Promise<void>;
}

export function createKeyBruteForceGuard(
  redis: Redis,
  policy: BruteForcePolicy,
  mode: GuardFailureMode = {},
): KeyBruteForceGuard {
  const failClosed = (mode.failMode ?? 'closed') === 'closed';
  const rethrow = (error: unknown): never => {
    if (failClosed) throw new AuthGuardUnavailableError(error);
    return undefined as never;
  };
  return {
    async isLocked(keyHash) {
      try {
        const ttl = await redis.ttl(lockKey(keyHash));
        if (ttl > 0) return { locked: true, retryAfterSec: ttl };
        const fails = Number((await redis.get(failsKey(keyHash))) ?? 0);
        if (fails >= policy.failureThreshold) return { locked: true, retryAfterSec: policy.lockS };
      } catch (error) {
        rethrow(error); // fail-closed：抛错；fail-open：吞
      }
      return { locked: false, retryAfterSec: 0 };
    },

    async recordFailure(keyHash) {
      try {
        const key = failsKey(keyHash);
        const n = await redis.incr(key);
        if (n === 1) await redis.expire(key, policy.failureWindowS);
        if (n >= policy.failureThreshold) {
          await redis.set(lockKey(keyHash), '1', 'EX', policy.lockS);
          return { locked: true, retryAfterSec: policy.lockS };
        }
      } catch (error) {
        rethrow(error);
      }
      return { locked: false, retryAfterSec: 0 };
    },

    async recordSuccess(keyHash) {
      try {
        await redis.del(failsKey(keyHash), lockKey(keyHash));
      } catch {
        // best-effort：成功路径清理失败不反杀合法请求
      }
    },
  };
}

export interface AuthFailurePolicy {
  /** 窗口内允许的最大鉴权失败次数 */
  limit: number;
  /** 失败计数窗口 / 锁定时长（秒） */
  windowS: number;
}

const ipFailsKey = (ip: string) => `authfail:ip:${ip}`;
const ipLockKey = (ip: string) => `authfail:ip:lock:${ip}`;

export interface AuthFailureGuard {
  /** 是否已被锁定（请求前调用，避免对锁定来源继续查 DB） */
  isLocked(ip: string): Promise<GuardCheck>;
  /** 记录一次鉴权失败；达阈值即锁定 */
  recordFailure(ip: string): Promise<GuardCheck>;
  /** 成功即清零该来源的失败计数与锁定（正确密码不应被他人连坐锁死） */
  recordSuccess?(ip: string): Promise<void>;
}

export function createAuthFailureGuard(
  redis: Redis,
  policy: AuthFailurePolicy,
  mode: GuardFailureMode = {},
): AuthFailureGuard {
  const failClosed = (mode.failMode ?? 'closed') === 'closed';
  const rethrow = (error: unknown): never => {
    if (failClosed) throw new AuthGuardUnavailableError(error);
    return undefined as never;
  };
  return {
    async isLocked(ip) {
      try {
        const ttl = await redis.ttl(ipLockKey(ip));
        if (ttl > 0) return { locked: true, retryAfterSec: ttl };
      } catch (error) {
        rethrow(error);
      }
      return { locked: false, retryAfterSec: 0 };
    },

    async recordFailure(ip) {
      try {
        const key = ipFailsKey(ip);
        const n = await redis.incr(key);
        if (n === 1) await redis.expire(key, policy.windowS);
        if (n >= policy.limit) {
          await redis.set(ipLockKey(ip), '1', 'EX', policy.windowS);
          return { locked: true, retryAfterSec: policy.windowS };
        }
      } catch (error) {
        rethrow(error);
      }
      return { locked: false, retryAfterSec: 0 };
    },

    async recordSuccess(ip) {
      try {
        await redis.del(ipFailsKey(ip), ipLockKey(ip));
      } catch (error) {
        rethrow(error);
      }
    },
  };
}
