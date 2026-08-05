import type { Redis } from 'ioredis';
import type { Db } from '@ai-gateway/db';
import { users } from '@ai-gateway/db/schema';
import { eq, sql } from 'drizzle-orm';
import { Decimal, toDecimal, toStorage } from '@ai-gateway/money';

/**
 * 预扣计费（billing hold）—— 重构后：DB 行锁权威账本，Redis 仅作在途标记。
 *
 * 架构（金融级 / Stripe 量级）：
 *   - 权威余额在 DB（numeric(24,18) 元），不再用 Redis 缓存余额（消除缓存一致性 bug）。
 *   - hold/release 用 DB 条件 UPDATE + 行锁防并发超卖（PG 单行 UPDATE 天然原子串行）。
 *   - Redis 仅存 hold 在途标记（value = "userId:amount"，amount 是元的小数字符串），
 *     用于 reclaim 兜底（gateway 崩溃后残留 hold 的退还）。Redis 不可用时 hold 仍可用
 *     （仅丢失 reclaim 兜底，hold TTL 标记缺失不影响 DB 扣费正确性）。
 *
 * 失败语义：DB 不可用 → hold 抛错 → gateway 返回 503（DB 是唯一权威，挂了本就不可用）。
 */

const KEY_HOLD = (requestId: string) => `billing:hold:${requestId}`;

/** Lua：原子 GET hold + 校验 + DEL（防重复 release/reclaim 退还两次） */
const RELEASE_HOLD_SCRIPT = `
local v = redis.call('GET', KEYS[1])
if not v then return '' end
redis.call('DEL', KEYS[1])
return v
`;

export interface HoldResult {
  ok: boolean;
  /** 扣减后余额（元，string），ok=false 时为当前余额 */
  balance: string;
  /** ok=false 时的原因 */
  reason?: 'insufficient';
}

export class BillingService {
  private releaseSha: string | null = null;
  /** 单次 hold 标记 TTL（ms），兜底防 gateway 崩溃后 hold 永久残留锁余额 */
  private readonly holdTtlMs: number;

  constructor(
    private readonly redis: Redis,
    private readonly db: Db,
    holdTtlMs: number = 600_000,
  ) {
    this.holdTtlMs = holdTtlMs;
  }

  /** 从 DB 读权威余额（元，string）。不再有 Redis 缓存。 */
  async getBalance(userId: number): Promise<string> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { balance: true },
    });
    return user?.balance ?? '0';
  }

  /**
   * 预扣：DB 条件 UPDATE（balance >= amount 才扣，防超卖）+ Redis 在途标记。
   *
   * @param userId 用户 ID
   * @param requestId 请求 ID（hold 标记 key）
   * @param amount 预扣金额（元，Decimal|string|number）
   * @returns ok=true 时 balance=扣减后余额；ok=false 时 balance=当前余额（不足）
   */
  async hold(userId: number, requestId: string, amount: Decimal | string | number): Promise<HoldResult> {
    const amt = toStorage(toDecimal(amount));
    // DB 条件 UPDATE：仅当余额足够时扣减（PG 行锁串行化同用户并发，防超卖）
    const updated = await this.db
      .update(users)
      .set({ balance: sql`${users.balance} - ${amt}`, updatedAt: new Date() })
      .where(sql`${users.id} = ${userId} AND ${users.balance} >= ${amt}`)
      .returning({ balance: users.balance });
    if (updated.length === 0) {
      // 余额不足（或用户不存在）
      const current = await this.getBalance(userId);
      return { ok: false, balance: current, reason: 'insufficient' };
    }
    const newBalance = updated[0]!.balance;
    // Redis 在途标记（best-effort，不阻塞；不可用时仅丢失 reclaim 兜底）
    try {
      await this.redis.set(KEY_HOLD(requestId), `${userId}:${amt}`, 'PX', this.holdTtlMs);
    } catch {
      // Redis 不可用：DB 已扣减正确，仅失去 reclaim 兜底（hold 残留需人工/定时清理）
    }
    return { ok: true, balance: newBalance };
  }

  /**
   * 释放 hold：DB 加回金额 + 删 Redis 标记（幂等，重复释放返回 0 无副作用）。
   * @returns 退还后余额（元，string）；hold 不存在返回 '' （幂等无操作）
   */
  async release(userId: number, requestId: string): Promise<string> {
    // 原子取 hold 标记（GET+DEL，防重复 release 退两次）
    let held: string | null = null;
    try {
      const sha = await this.ensureReleaseSha();
      held = (await this.redis.evalsha(sha, 1, KEY_HOLD(requestId))) as string;
    } catch {
      // Redis 不可用：无法判定是否已释放，幂等返回（不重复退，防双退）
      return '';
    }
    if (!held) return ''; // hold 不存在（已释放/已过期/Redis 不可用时未写）
    const m = /^(\d+):(.+)$/.exec(held);
    if (!m) return '';
    const amt = m[2]!;
    // DB 加回金额（原子 UPDATE）
    const updated = await this.db
      .update(users)
      .set({ balance: sql`${users.balance} + ${amt}`, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning({ balance: users.balance });
    return updated[0]?.balance ?? '';
  }

  /**
   * 回收泄漏 hold：scan billing:hold:*，对 TTL=-1（无 TTL 残留）的标记退还余额并删除。
   * 由 worker 定期调用（如每分钟）。Redis 不可用时返回 0。
   * @returns 回收的 hold 数量
   */
  async reclaimExpiredHolds(): Promise<number> {
    let cursor = '0';
    let reclaimed = 0;
    try {
      do {
        const [next, keys] = (await this.redis.scan(cursor, 'MATCH', KEY_HOLD('*'), 'COUNT', 200)) as [string, string[]];
        cursor = next;
        for (const holdKey of keys) {
          const ttl = await this.redis.pttl(holdKey);
          // 仅回收无 TTL 的异常残留（-1）；-2=不存在跳过；>=0=仍在 TTL 内的在途 hold 不动
          if (ttl !== -1) continue;
          // 原子取 + 删（防与正常 release 竞态）
          const sha = await this.ensureReleaseSha();
          const held = (await this.redis.evalsha(sha, 1, holdKey)) as string;
          if (!held) continue;
          const m = /^(\d+):(.+)$/.exec(held);
          if (!m) continue;
          const userId = Number(m[1]);
          const amount = m[2]!;
          // DB 退还余额（原子 UPDATE）
          await this.db
            .update(users)
            .set({ balance: sql`${users.balance} + ${amount}`, updatedAt: new Date() })
            .where(eq(users.id, userId));
          reclaimed += 1;
        }
      } while (cursor !== '0');
    } catch {
      // Redis 不可用：无 hold 可回收
    }
    return reclaimed;
  }

  private async ensureReleaseSha(): Promise<string> {
    if (this.releaseSha) return this.releaseSha;
    this.releaseSha = (await this.redis.script('LOAD', RELEASE_HOLD_SCRIPT)) as unknown as string;
    return this.releaseSha;
  }
}
