/**
 * 爆破防护的本地内存降级体（degraded 档的执行器）。
 *
 * 定位：Redis 不可用期间，鉴权爆破防护从「精确滑动计数 + 跨副本共享锁」
 * 降质为「每实例独立固定窗口计数 + 本地锁」——牺牲防护精度（多副本各计
 * 各的，攻击量被副本数摊薄）换取登录可用性（不 503）。企业级「降质换可用」
 * 的标准形态：Redis 恢复后本降级体自然废弃（无状态迁移，下次读写回到 Redis）。
 *
 * 防泄漏：维度空间无上界（攻击者可用海量随机 keyHash/IP 撑内存）——达到
 * maxEntries 上限时整表丢弃重计（攻击态丢计数可接受：降级窗口短暂，
 * sentinel 形态 ~5s；且丢表后攻击者从头计数仍会被截获）。
 */
import type {
  AuthFailureGuard,
  BruteForcePolicy,
  GuardCheck,
  KeyBruteForceGuard,
} from './auth-guards.js';

/** 单维度计数（固定窗口） */
interface Cell {
  windowStart: number;
  fails: number;
  lockedUntil: number;
}

/** 本地固定窗口计数器（惰性过期 + 容量上限整表重置） */
/** 模块级时钟（不随计数器实例重建） */
const now = () => Date.now();

function createLocalCounter(limit: number, windowMs: number, lockMs: number, maxEntries = 100_000) {
  const cells = new Map<string, Cell>();

  const read = (dim: string): Cell => {
    let cell = cells.get(dim);
    const t = now();
    if (!cell || t - cell.windowStart >= windowMs) {
      if (cells.size >= maxEntries) cells.clear(); // 容量保护：整表重计
      cell = { windowStart: t, fails: 0, lockedUntil: 0 };
      cells.set(dim, cell);
    }
    return cell;
  };

  return {
    isLocked(dim: string): GuardCheck {
      const cell = read(dim);
      const remainMs = cell.lockedUntil - now();
      return remainMs > 0
        ? { locked: true, retryAfterSec: Math.ceil(remainMs / 1000) }
        : { locked: false, retryAfterSec: 0 };
    },
    recordFailure(dim: string): GuardCheck {
      const cell = read(dim);
      cell.fails += 1;
      if (cell.fails >= limit) {
        cell.lockedUntil = now() + lockMs;
        cell.fails = 0; // 锁定即重计（锁内再次失败由 locked 判定挡住）
        return { locked: true, retryAfterSec: Math.ceil(lockMs / 1000) };
      }
      return { locked: false, retryAfterSec: 0 };
    },
    recordSuccess(dim: string): void {
      cells.delete(dim);
    },
  };
}

/** KeyBruteForceGuard 的本地降级体（维度=keyHash，策略同 Redis 版语义） */
export function createLocalKeyBruteForceGuard(policy: BruteForcePolicy): KeyBruteForceGuard {
  const counter = createLocalCounter(
    policy.failureThreshold,
    policy.failureWindowS * 1000,
    policy.lockS * 1000,
  );
  return {
    isLocked: (keyHash) => Promise.resolve(counter.isLocked(keyHash)),
    recordFailure: (keyHash) => Promise.resolve(counter.recordFailure(keyHash)),
    recordSuccess: (keyHash) => {
      counter.recordSuccess(keyHash);
      return Promise.resolve();
    },
  };
}

/** AuthFailureGuard 的本地降级体（维度=来源 IP；锁长=窗口长，与 Redis 版一致） */
export function createLocalAuthFailureGuard(limit: number, windowS: number): AuthFailureGuard {
  const counter = createLocalCounter(limit, windowS * 1000, windowS * 1000);
  return {
    isLocked: (ip) => Promise.resolve(counter.isLocked(ip)),
    recordFailure: (ip) => Promise.resolve(counter.recordFailure(ip)),
    recordSuccess: (ip) => {
      counter.recordSuccess(ip);
      return Promise.resolve();
    },
  };
}
