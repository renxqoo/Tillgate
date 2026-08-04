import type { Redis } from 'ioredis';
import type { Db } from '@ai-gateway/db';
import { users } from '@ai-gateway/db/schema';
import { eq } from 'drizzle-orm';

/**
 * 预扣计费（billing hold）—— gateway 侧同步预扣（Redis 原子），结算留 worker（异步）。
 *
 * Redis 数据结构：
 *   balance:{userId}  → 用户余额缓存（厘），lazy 从 DB 加载，由事务/结算维护
 *   hold:{requestId}  → 预扣金额（厘），TTL 10min（防 gateway crash 后 hold 泄漏）
 *
 * 一致性模型：
 *   - 预扣/释放都在 Redis（原子 Lua，防并发超额）
 *   - 实际扣费由 worker 在 DB 做（写 transactions + 刷新 balance），并覆盖 Redis 缓存
 *   - 短暂窗口（gateway 释放 hold 后 worker 结算前）Redis 余额是近似值，worker 结算后校正
 */

const KEY_BALANCE = (userId: number) => `billing:balance:${userId}`;
const KEY_HOLD = (requestId: string) => `billing:hold:${requestId}`;

// 预扣 Lua：原子 余额校验 → 扣减 → 记 hold
//   返回 ≥0 = 扣减后余额；-1 = 余额不足；-2 = 余额缓存缺失（需加载）
const HOLD_SCRIPT = `
local bal = redis.call('GET', KEYS[1])
if not bal then return -2 end
bal = tonumber(bal)
if bal < tonumber(ARGV[1]) then return -1 end
local newBal = redis.call('DECRBY', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[2])
return newBal
`;

// 释放 Lua：原子 检查 hold 存在 → 余额恢复 → 删 hold（防重复释放）
//   返回 ≥0 = 恢复后余额；-1 = hold 不存在（已释放或过期）
const RELEASE_SCRIPT = `
local held = redis.call('GET', KEYS[2])
if not held then return -1 end
local newBal = redis.call('INCRBY', KEYS[1], held)
redis.call('DEL', KEYS[2])
return newBal
`;

export interface HoldResult {
  ok: boolean;
  /** 扣减后余额（厘），ok=false 时为当前余额（供错误信息用） */
  balance: number;
  /** ok=false 时的原因 */
  reason?: 'insufficient' | 'cache_miss';
  /** ok=true 时，Redis 降级（不可用，跳过预扣直接放行）→ worker 结算时 DB 权威兜底 */
  degraded?: boolean;
}

export class BillingService {
  private holdSha: string | null = null;
  private releaseSha: string | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly db: Db,
    private readonly holdTtlMs: number = 600_000,
  ) {}

  /** 从 Redis 读余额缓存；缓存缺失时从 DB 加载（lazy 初始化）。Redis 不可用时降级查 DB */
  async getBalance(userId: number): Promise<number> {
    try {
      const cached = await this.redis.get(KEY_BALANCE(userId));
      if (cached !== null) return Number(cached);
    } catch {
      // Redis 不可用 → 降级查 DB
    }
    return this.loadBalanceFromDb(userId);
  }

  /** 从 DB 加载余额到 Redis 缓存（SET NX：不覆盖已有缓存，防并发重复加载） */
  async loadBalanceFromDb(userId: number): Promise<number> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { balance: true },
    });
    const balance = user?.balance ?? 0;
    try {
      await this.redis.set(KEY_BALANCE(userId), balance, 'NX');
    } catch {
      // Redis 不可用：仅返回 DB 值，不写缓存（下次仍查 DB）
    }
    return balance;
  }

  /**
   * 预扣：Redis 原子扣减余额 + 记 hold。
   * 余额缓存缺失时自动从 DB 加载后重试一次。
   *
   * 高可用容错：Redis 不可用时 fail-open（跳过预扣直接放行，标 degraded=true）。
   * 宁可漏扣（worker 结算时 DB 权威兜底）也不能全站 500。
   */
  async hold(userId: number, requestId: string, amount: number): Promise<HoldResult> {
    try {
      const sha = await this.ensureHoldSha();
      const balanceKey = KEY_BALANCE(userId);
      const holdKey = KEY_HOLD(requestId);

      const res = (await this.redis.evalsha(sha, 2, balanceKey, holdKey, amount, this.holdTtlMs)) as number;

      if (res === -2) {
        // 余额缓存缺失：从 DB 加载后重试一次
        await this.loadBalanceFromDb(userId);
        const retry = (await this.redis.evalsha(sha, 2, balanceKey, holdKey, amount, this.holdTtlMs)) as number;
        if (retry === -2) return { ok: false, balance: 0, reason: 'cache_miss' };
        if (retry === -1) {
          return { ok: false, balance: await this.getBalance(userId), reason: 'insufficient' };
        }
        return { ok: true, balance: retry };
      }
      if (res === -1) {
        return { ok: false, balance: await this.getBalance(userId), reason: 'insufficient' };
      }
      return { ok: true, balance: res };
    } catch {
      // Redis 不可用 → fail-open：跳过预扣放行请求（worker 结算时 DB 权威兜底）
      return { ok: true, balance: 0, degraded: true };
    }
  }

  /**
   * 释放 hold：Redis 原子恢复余额 + 删 hold（幂等，重复释放返回 -1 无副作用）。
   * Redis 不可用时静默返回 -1（hold TTL 10min 会自然过期，最终一致）。
   */
  async release(userId: number, requestId: string): Promise<number> {
    try {
      const sha = await this.ensureReleaseSha();
      const res = (await this.redis.evalsha(
        sha,
        2,
        KEY_BALANCE(userId),
        KEY_HOLD(requestId),
      )) as number;
      return res;
    } catch {
      return -1; // Redis 不可用：hold TTL 兜底
    }
  }

  private async ensureHoldSha(): Promise<string> {
    if (this.holdSha) return this.holdSha;
    this.holdSha = (await this.redis.script('LOAD', HOLD_SCRIPT)) as unknown as string;
    return this.holdSha;
  }

  private async ensureReleaseSha(): Promise<string> {
    if (this.releaseSha) return this.releaseSha;
    this.releaseSha = (await this.redis.script('LOAD', RELEASE_SCRIPT)) as unknown as string;
    return this.releaseSha;
  }
}
