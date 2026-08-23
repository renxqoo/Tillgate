/**
 * 鉴权爆破防护（v1 ai-getway packages/core/src/redis/auth-guards.ts 平移；C-G5），
 * 两层防护语义：
 *   - keyBruteForceGuard：保护「单个 Key」不被爆破（维度=keyHash：窗口内失败
 *     N 次锁 M 分钟，成功即清零）
 *   - authFailureGuard：保护「网关整体」不被单来源无差别刷鉴权失败（维度=来源
 *     IP——per-key 计数可被换随机 Key 绕过，攻击者可用海量随机 Key 打爆日志与键空间）
 *
 * 故障语义（Redis 是首选组件）——三档，默认 degraded：
 *   - degraded（默认，企业生产形态）：Redis 不可用时降质为每实例内存粗限
 *     （auth-local-guard：固定窗口 + 本地锁）——牺牲防护精度换取登录可用性，
 *     不 503；Redis 恢复后自然回到精确计数。
 *   - closed：抛 InfrastructureError('runtime.auth_guard_unavailable')，调用方拒绝
 *     鉴权（503）——防护绝对优先（内部高安全部署）。
 *   - open：放行（仅失去防护）——单副本开发形态。
 * recordSuccess 恒 best-effort（成功路径的清理失败不反杀合法请求）。
 * keyHash/IP 的提取语义（可信代理跳数）由调用方注入。
 */
import { InfrastructureError } from '@tokenlens/errors';
import type { Redis } from 'ioredis';
import { createLocalAuthFailureGuard, createLocalKeyBruteForceGuard } from './auth-local-guard.js';

/** fail-closed 语义的防护存储错误（face 渲染 infrastructure → 503 + 身份码） */
export function authGuardUnavailable(cause: unknown): InfrastructureError {
  return new InfrastructureError(
    `auth guard storage unavailable: ${(cause as Error)?.message ?? String(cause)}`,
    'runtime.auth_guard_unavailable',
  );
}

export type GuardFailMode = 'open' | 'closed' | 'degraded';

export interface GuardFailureMode {
  /**
   * Redis 故障语义：degraded（默认）= 降质为每实例内存粗限（保登录可用）；
   * closed = 抛错拒绝（503）；open = 放行（仅失去防护）。
   * 多副本语义：degraded 的本地计数每实例独立——攻击量被副本数摊薄，
   * 阈值效果按副本数打折（降质窗口短暂，sentinel 形态 ~5s，可接受）。
   */
  failMode?: GuardFailMode;
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
  const failMode = mode.failMode ?? 'degraded';
  const local = createLocalKeyBruteForceGuard(policy);
  const failClosed = failMode === 'closed';
  // degraded：存储不可用时改走本地降级体的同语义结果（降质不拒绝）
  const degraded = <T>(op: (l: KeyBruteForceGuard) => Promise<T>, error: unknown): Promise<T> => {
    if (failMode !== 'degraded') {
      if (failClosed) throw authGuardUnavailable(error);
      return Promise.resolve({ locked: false, retryAfterSec: 0 } as T); // open：放行
    }
    return op(local);
  };
  return {
    async isLocked(keyHash) {
      try {
        const ttl = await redis.ttl(lockKey(keyHash));
        if (ttl > 0) return { locked: true, retryAfterSec: ttl };
        const fails = Number((await redis.get(failsKey(keyHash))) ?? 0);
        if (fails >= policy.failureThreshold) return { locked: true, retryAfterSec: policy.lockS };
      } catch (error) {
        return degraded((l) => l.isLocked(keyHash), error);
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
        return degraded((l) => l.recordFailure(keyHash), error);
      }
      return { locked: false, retryAfterSec: 0 };
    },

    async recordSuccess(keyHash) {
      try {
        await redis.del(failsKey(keyHash), lockKey(keyHash));
      } catch {
        // best-effort：成功路径清理失败不反杀合法请求；降级体同步清（正确密码不被连坐）
        if (failMode === 'degraded') await local.recordSuccess(keyHash);
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
  const failMode = mode.failMode ?? 'degraded';
  const local = createLocalAuthFailureGuard(policy.limit, policy.windowS);
  const failClosed = failMode === 'closed';
  const degraded = <T>(op: (l: AuthFailureGuard) => Promise<T>, error: unknown): Promise<T> => {
    if (failMode !== 'degraded') {
      if (failClosed) throw authGuardUnavailable(error);
      return Promise.resolve({ locked: false, retryAfterSec: 0 } as T); // open：放行
    }
    return op(local);
  };
  return {
    async isLocked(ip) {
      try {
        const ttl = await redis.ttl(ipLockKey(ip));
        if (ttl > 0) return { locked: true, retryAfterSec: ttl };
      } catch (error) {
        return degraded((l) => l.isLocked!(ip), error);
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
        return degraded((l) => l.recordFailure(ip), error);
      }
      return { locked: false, retryAfterSec: 0 };
    },

    async recordSuccess(ip) {
      try {
        await redis.del(ipFailsKey(ip), ipLockKey(ip));
      } catch {
        // best-effort：成功路径清理失败不反杀合法请求；降级体同步清（正确密码不被连坐）
        if (failMode === 'degraded') await local.recordSuccess?.(ip);
      }
    },
  };
}
