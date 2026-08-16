import { Hono } from 'hono';
import { z } from 'zod';
import { jsonBody, query } from '@ai-gateway/http';
import type { ClientEnv } from '@ai-gateway/identity';
import type { ClientServices } from '../services/index.js';
import { listMyRedeemHistory, redeemCode, redeemHistoryQuerySchema } from '../services/redeem.js';

/**
 * 用户面板：充值码兑换（api-contract §4.1）。
 *
 *   - POST /：兑换充值码（限流 10 次/分钟，ledger 事务幂等；失败分支由
 *     service 抛 FlowError，errorHandler 统一出响应）
 *   - GET /history：我的兑换记录（只展示已兑换的；不含明文码/哈希，安全）
 */

const redeemSchema = z.object({ code: z.string().min(1).max(64) });

export function redeemRoutes(s: ClientServices): Hono<ClientEnv> {
  return new Hono<ClientEnv>()

    // 兑换充值码
    .post('/', jsonBody(redeemSchema), async (c) => {
      const session = c.get('session');
      const body = c.req.valid('json');
      const outcome = await redeemCode(s, session.userId, body.code);
      return c.json({ ok: true, amount: outcome.amount, balanceAfter: outcome.balanceAfter });
    })

    // 我的兑换记录（已兑换的；不含明文码/哈希）
    .get('/history', query(redeemHistoryQuerySchema), async (c) =>
      c.json(await listMyRedeemHistory(s, c.get('session').userId, c.req.valid('query'))),
    );
}
