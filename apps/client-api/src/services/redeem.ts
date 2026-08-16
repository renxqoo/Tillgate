import { eq } from 'drizzle-orm';
import { redeemBatches, redeemCodes } from '@ai-gateway/db/schema';
import { buildList, countAll, paginateQuery, paginationQuerySchema, FlowError, sortQuerySchema, type KnownErrorCode } from '@ai-gateway/http';
import { z } from 'zod';

import type { ClientServices } from './index.js';

/**
 * 充值码兑换组件（限流 + ledger 兑换）。
 *
 * 限流：10 次/分钟（P-1 修复：防脚本爆破充值码），键 redeem:rl:{userId}。
 * 兑换本身由 ledger.redeemCode 事务完成（幂等 + 冲正安全）。
 * 失败分支在判定处直接 throw FlowError，errorHandler 统一出响应。
 */

export const REDEEM_RATE_LIMIT_PER_MIN = 10;
const RATE_LIMIT_WINDOW_S = 60;

/** ledger 拒绝 reason（运行时值）→ 注册表错误码；状态码/文案从注册表单一真相推导 */
const REJECT_CODE: Record<'invalid_code' | 'code_already_used' | 'code_revoked' | 'code_expired', KnownErrorCode> = {
  invalid_code: 'REDEEM_INVALID_CODE',
  code_already_used: 'REDEEM_CODE_ALREADY_USED',
  code_revoked: 'REDEEM_CODE_REVOKED',
  code_expired: 'REDEEM_CODE_EXPIRED',
};

export type RedeemSuccess = { kind: 'success'; amount: string; balanceAfter: string };

export async function redeemCode(
  s: ClientServices,
  userId: number,
  code: string,
): Promise<RedeemSuccess> {
  const key = `redeem:rl:${userId}`;
  // 原子 INCR+EXPIRE（Lua）：incr/expire 两步在崩溃间隙会留下无 TTL 键 → 用户永久 429
  const n = (await s.redis.eval(
    'local v = redis.call("INCR", KEYS[1]) ' +
      'if v == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end return v',
    1,
    key,
    RATE_LIMIT_WINDOW_S,
  )) as number;
  if (n > REDEEM_RATE_LIMIT_PER_MIN) {
    const ttl = await s.redis.ttl(key);
    throw new FlowError('rate_limited', {
      code: 'RATE_LIMITED',
      message: '兑换过于频繁，请稍后再试',
      headers: { 'retry-after': String(Math.max(1, ttl)) },
    });
  }

  const r = await s.ledger.redeemCode({ userId, code });
  if (!r.ok) throw new FlowError('rejected', { code: REJECT_CODE[r.reason] });
  return { kind: 'success', amount: r.amount, balanceAfter: r.balanceAfter };
}

/** 我的兑换记录（已兑换的；不含明文码/哈希，安全） */
export async function listMyRedeemHistory(
  s: ClientServices,
  userId: number,
  input: z.infer<typeof redeemHistoryQuerySchema>,
) {
  const { page, limit, offset, where, orderBy } = buildList(input, {
    conditions: [eq(redeemCodes.usedBy, userId), eq(redeemCodes.status, 1)],
    sort: { by: { id: redeemCodes.id, usedAt: redeemCodes.usedAt }, fallback: 'usedAt', tiebreaker: redeemCodes.id },
  });
  return paginateQuery(
    page,
    s.db
      .select({
        id: redeemCodes.id,
        amount: redeemBatches.amount,
        batchName: redeemBatches.name,
        usedAt: redeemCodes.usedAt,
      })
      .from(redeemCodes)
      .innerJoin(redeemBatches, eq(redeemCodes.batchId, redeemBatches.id))
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    countAll(s.db, redeemCodes, where),
  );
}

export const redeemHistoryQuerySchema = paginationQuerySchema.extend({ ...sortQuerySchema.shape });

