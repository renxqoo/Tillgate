import type { ClientServices } from './index.js';

/**
 * 充值码兑换组件（限流 + ledger 兑换）。
 *
 * 限流：10 次/分钟（P-1 修复：防脚本爆破充值码），键 redeem:rl:{userId}。
 * 兑换本身由 ledger.redeemCode 事务完成（幂等 + 冲正安全）。
 */

export const REDEEM_RATE_LIMIT_PER_MIN = 10;
const RATE_LIMIT_WINDOW_S = 60;

export type RedeemOutcome =
  | { kind: 'rate_limited'; retryAfterSec: number }
  | { kind: 'success'; amount: string; balanceAfter: string }
  | { kind: 'rejected'; reason: string };

export async function redeemCode(
  s: ClientServices,
  userId: number,
  code: string,
): Promise<RedeemOutcome> {
  const key = `redeem:rl:${userId}`;
  const n = await s.redis.incr(key);
  if (n === 1) await s.redis.expire(key, RATE_LIMIT_WINDOW_S);
  if (n > REDEEM_RATE_LIMIT_PER_MIN) {
    const ttl = await s.redis.ttl(key);
    return { kind: 'rate_limited', retryAfterSec: Math.max(1, ttl) };
  }

  const r = await s.ledger.redeemCode({ userId, code });
  if (!r.ok) return { kind: 'rejected', reason: r.reason };
  return { kind: 'success', amount: r.amount, balanceAfter: r.balanceAfter };
}
