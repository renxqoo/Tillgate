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

/**
 * C2 修复：余额缓存兜底 TTL。
 * settle 正常路径会 DEL 余额缓存；但若 DEL 漏掉（崩溃/竞态/漏改路径），无 TTL 会永久脏。
 * 1 小时兜底：远大于正常 settle 延迟（秒级），仅在异常时作为最终一致性兜底。
 */
const BALANCE_CACHE_TTL_S = 3600;

// 预扣 Lua：原子 余额校验 → 扣减 → 记 hold
//   hold value 格式 = "<userId>:<amount>"（C3 修复：含 userId，让过期回收 sweep 无需请求上下文即可退余额）
//   返回 ≥0 = 扣减后余额；-1 = 余额不足；-2 = 余额缓存缺失（需加载）
const HOLD_SCRIPT = `
local bal = redis.call('GET', KEYS[1])
if not bal then return -2 end
bal = tonumber(bal)
if bal < tonumber(ARGV[1]) then return -1 end
local newBal = redis.call('DECRBY', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[3] .. ':' .. ARGV[1], 'PX', ARGV[2])
return newBal
`;

// 释放 Lua：原子 检查 hold 存在 → 余额恢复 → 删 hold（防重复释放）
//   hold value = "<userId>:<amount>"，取 : 后的 amount 还原余额
//   返回 ≥0 = 恢复后余额；-1 = hold 不存在（已释放或过期）
const RELEASE_SCRIPT = `
local held = redis.call('GET', KEYS[2])
if not held then return -1 end
local amount = string.match(held, ":([^:]+)$")
local newBal = redis.call('INCRBY', KEYS[1], tonumber(amount))
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
      // C2 修复：SET NX + EX 兜底 TTL。NX 不覆盖进行中 hold 的占位；EX 保证漏 DEL 时最终过期。
      // ioredis 6 重载要求顺序：value, 'EX', seconds, 'NX'
      await this.redis.set(KEY_BALANCE(userId), balance, 'EX', BALANCE_CACHE_TTL_S, 'NX');
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

      // ARGV: [amount, ttlMs, userId]（userId 写入 hold value 供过期回收 sweep）
      const res = (await this.redis.evalsha(sha, 2, balanceKey, holdKey, amount, this.holdTtlMs, userId)) as number;

      if (res === -2) {
        // 余额缓存缺失：从 DB 加载后重试一次
        await this.loadBalanceFromDb(userId);
        const retry = (await this.redis.evalsha(sha, 2, balanceKey, holdKey, amount, this.holdTtlMs, userId)) as number;
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
   * C3 修复：回收过期 hold 退还余额。
   *
   * 问题：hold 有 10min TTL，过期后 release 返回 -1 不退余额 → 若此时 settle 也未跑
   * （gateway 在 hold 后、入队前崩溃），被扣金额永久滞留 → 下次 hold 读到偏低余额 → 假 402。
   *
   * 设计：hold value 含 "userId:amount"。本 sweep 扫描所有 billing:hold:* 键，
   * 对 TTL < 阈值（即将过期/已过期被 SET 无 TTL 残留）的 hold 退还余额并删除。
   * 由 worker 定期调用（如每分钟）。
   *
   * 注意：正常的 release/settle 路径会主动删 hold；本 sweep 仅处理「泄漏」的残留 hold，
   * 因此对仍在 TTL 内、对应在途请求的 hold 不动（避免误退进行中预扣）。
   *
   * 泄漏判定：仅 ttl===-1（无 TTL 的异常残留）才算泄漏。
   *   - 已过期的 hold（TTL 到期）会被 Redis 自动删除，不会出现在 scan 结果中
   *   - ttl>0（仍在 TTL 内）= 正常在途请求的 hold，绝不能回收（否则 worker 结算时重复扣费 → 资损）
   *   - 旧的 ttl<expireThresholdMs 判断会把长请求最后几十秒的 hold 误判为泄漏 → 已移除
   *
   * @param _expireThresholdMs 已废弃（保留参数兼容旧调用点，不再使用）
   * @returns 回收的 hold 数量
   */
  async reclaimExpiredHolds(_expireThresholdMs = 0): Promise<number> {
    let cursor = '0';
    let reclaimed = 0;
    do {
      const [next, keys] = (await this.redis.scan(cursor, 'MATCH', `${KEY_HOLD('*')}`, 'COUNT', 200)) as [string, string[]];
      cursor = next;
      for (const holdKey of keys) {
        const ttl = await this.redis.pttl(holdKey);
        // 仅回收无 TTL 的异常残留（-1）。-2=已不存在跳过；>=0=仍在 TTL 内的在途 hold 不动。
        if (ttl !== -1) continue;
        const held = await this.redis.get(holdKey);
        if (!held) continue;
        const m = /^(\d+):(-?\d+)$/.exec(held);
        if (!m) continue;
        const userId = Number(m[1]);
        const amount = Number(m[2]);
        if (amount <= 0) continue;
        // 原子退还：DEL hold（仅当仍存在）→ INCRBY 余额。用 Lua 保证不重复退。
        const reclaimScript = `
local v = redis.call('GET', KEYS[1])
if not v then return -1 end
local amount = string.match(v, ":([^:]+)$")
redis.call('INCRBY', KEYS[2], tonumber(amount))
redis.call('DEL', KEYS[1])
return tonumber(amount)
`;
        const reclaimedAmount = (await this.redis.eval(reclaimScript, 2, holdKey, KEY_BALANCE(userId))) as number;
        if (reclaimedAmount > 0) reclaimed += 1;
      }
    } while (cursor !== '0');
    return reclaimed;
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
