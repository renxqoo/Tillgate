import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { redeemCodes, redeemBatches } from '@ai-gateway/db/schema';
import { z } from 'zod';
import {
  jsonBody, paginateQuery, query, buildList, countAll, paginationQuerySchema,
  sortQuerySchema, HttpError, type KnownErrorCode } from '@ai-gateway/http';
import type { ClientEnv } from '@ai-gateway/identity';
import type { ClientServices } from '../services/index.js';
import { redeemCode } from '../services/redeem.js';

/**
 * 用户面板：充值码兑换（api-contract §4.1）。
 *
 *   - POST /：兑换充值码（限流 10 次/分钟，ledger 事务幂等）
 *   - GET /history：我的兑换记录（只展示已兑换的；不含明文码/哈希，安全）
 */

const redeemSchema = z.object({ code: z.string().min(1).max(64) });

/** 兑换拒绝 reason → 注册表错误码（状态码/文案从注册表单一真相推导） */
const REDEEM_REJECT_CODE: Record<
  'invalid_code' | 'code_already_used' | 'code_revoked' | 'code_expired',
  KnownErrorCode
> = {
  invalid_code: 'REDEEM_INVALID_CODE',
  code_already_used: 'REDEEM_CODE_ALREADY_USED',
  code_revoked: 'REDEEM_CODE_REVOKED',
  code_expired: 'REDEEM_CODE_EXPIRED',
} as const;

export function redeemRoutes(s: ClientServices): Hono<ClientEnv> {
  return new Hono<ClientEnv>()

    // 兑换充值码
    .post('/', jsonBody(redeemSchema), async (c) => {
      const session = c.get('session');
      const body = c.req.valid('json');
      const outcome = await redeemCode(s, session.userId, body.code);

      switch (outcome.kind) {
        case 'rate_limited':
          throw new HttpError('RATE_LIMITED', '兑换过于频繁，请稍后再试', undefined, {
            'retry-after': String(outcome.retryAfterSec),
          });
        case 'rejected': {
          // 机器 reason → 注册表码 + 人类文案（此前直接把机器串当文案返回给用户）
          throw new HttpError(REDEEM_REJECT_CODE[outcome.reason]);
        }
        case 'success':
          return c.json({ ok: true, amount: outcome.amount, balanceAfter: outcome.balanceAfter });
      }
    })

    // 我的兑换记录（已兑换的；不含明文码/哈希）
    .get('/history', query(paginationQuerySchema.extend({ ...sortQuerySchema.shape })), async (c) => {
      const session = c.get('session');
      const input = c.req.valid('query');
      // 兑换记录无文本列，不提供 q
      const { page, limit, offset, where, orderBy } = buildList(input, {
        conditions: [eq(redeemCodes.usedBy, session.userId), eq(redeemCodes.status, 1)],
        sort: { by: { id: redeemCodes.id, usedAt: redeemCodes.usedAt }, fallback: 'usedAt', tiebreaker: redeemCodes.id },
      });
      const result = await paginateQuery(
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
      return c.json(result);
    });
}
