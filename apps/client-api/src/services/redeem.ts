import { and, eq, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { redeemBatches, redeemCodes } from '@ai-gateway/db/schema';
import { createDomainOperations } from '@ai-gateway/ledger/platform';
import { buildList, countAll, paginateQuery, paginationQuerySchema, FlowError, sortQuerySchema, type KnownErrorCode } from '@ai-gateway/http';
import { z } from 'zod';

import type { ClientServices } from './index.js';

/**
 * 充值码兑换组件（S7 重写：app 自有状态机 + wallet 入账）。
 *
 * 限流：10 次/分钟（防脚本爆破充值码），键 redeem:rl:{userId}。
 * 兑换 = ledger-core 幂等事务（kind 'redeem'）：码 CAS（status 0→1 +
 * 未过期）→ batch usedCount++ → wallet.credit（counter-leg = outside）。
 * 失败分支在判定处直接 throw FlowError，errorHandler 统一出响应。
 */

export const REDEEM_RATE_LIMIT_PER_MIN = 10;
const RATE_LIMIT_WINDOW_S = 60;

/** 兑换拒绝 reason → 注册表错误码；状态码/文案从注册表单一真相推导 */
const REJECT_CODE: Record<'invalid_code' | 'code_already_used' | 'code_revoked' | 'code_expired', KnownErrorCode> = {
  invalid_code: 'REDEEM_INVALID_CODE',
  code_already_used: 'REDEEM_CODE_ALREADY_USED',
  code_revoked: 'REDEEM_CODE_REVOKED',
  code_expired: 'REDEEM_CODE_EXPIRED',
};

export type RedeemSuccess = { kind: 'success'; amount: string; balanceAfter: string };

type RedeemOutcome =
  | { ok: true; amount: string; balanceAfter: string }
  | { ok: false; reason: keyof typeof REJECT_CODE };

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

  const codeHash = createHash('sha256').update(code).digest('hex');
  const operationId = `redeem:${codeHash}:${userId}`;
  const operations = createDomainOperations(s.db, ['redeem']);
  const { receipt } = await operations.run<RedeemOutcome>({
    operationId,
    kind: 'redeem',
    fingerprint: { kind: 'redeem', userId, codeHash },
    execute: async (tx) => {
      const now = new Date();
      const claimed = await tx
        .update(redeemCodes)
        .set({ status: 1, usedBy: userId, usedAt: now })
        .where(
          and(
            eq(redeemCodes.codeHash, codeHash),
            eq(redeemCodes.status, 0),
            // OR 必须整体加括号：and() 不给裸 SQL 片段加括号，AND 优先级高于 OR
            sql`(${redeemCodes.expiresAt} is null or ${redeemCodes.expiresAt} > ${now})`,
          ),
        )
        .returning({ id: redeemCodes.id, batchId: redeemCodes.batchId });
      if (claimed.length === 0) {
        const row = await tx.query.redeemCodes.findFirst({
          where: eq(redeemCodes.codeHash, codeHash),
        });
        const reason = !row
          ? 'invalid_code'
          : row.status === 1
            ? 'code_already_used'
            : row.status === 2
              ? 'code_revoked'
              : 'code_expired';
        return { ok: false as const, reason: reason as keyof typeof REJECT_CODE };
      }
      const [batch] = await tx
        .update(redeemBatches)
        .set({ usedCount: sql`${redeemBatches.usedCount} + 1` })
        .where(eq(redeemBatches.id, claimed[0]!.batchId))
        .returning({ amount: redeemBatches.amount });
      if (!batch) throw new Error(`batch_not_found:${claimed[0]!.batchId}`);
      const posted = await s.wallet.credit({
        userId,
        amount: batch.amount,
        refType: 'redeem',
        refId: operationId,
        memo: '兑换码入账',
        tx: tx as unknown as import('@ai-gateway/wallet').DbLike,
      });
      return { ok: true as const, amount: batch.amount, balanceAfter: posted.balanceAfter };
    },
  });
  if (!receipt.ok) throw new FlowError('rejected', { code: REJECT_CODE[receipt.reason] });
  return { kind: 'success', amount: receipt.amount, balanceAfter: receipt.balanceAfter };
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

