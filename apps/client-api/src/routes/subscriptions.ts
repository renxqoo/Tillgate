import { Hono } from 'hono';
import { z } from 'zod';
import { HttpError, intParam, jsonBody, operationId, type KnownErrorCode } from '@ai-gateway/http';
import { LedgerError, LEDGER_HTTP } from '@ai-gateway/ledger';
import type { ClientEnv } from '@ai-gateway/identity';
import type { ClientServices } from '../services/index.js';

/**
 * 用户面板：套餐购买/变更（api-contract §4.9）。
 *   - POST /：用余额购买（扣余额、开订阅期），quantity=席位（默认 1）
 *   - POST /:id/change：升级/加席位（补差价，只能升不能降）
 *   - POST /:id/renew：续费（按原席位扣余额、旧订阅转到期、新订阅顺延）
 */
/** 席位上限：防 numeric 溢出与恶意超大值（足够任何企业团队，超此规模走线下） */
const SEATS_MAX = 1000;

const purchaseSchema = z.object({
  planId: z.number().int().positive(),
  quantity: z.number().int().min(1).max(SEATS_MAX).optional(),
});

const changeSchema = z.object({
  targetPlanId: z.number().int().positive(),
  quantity: z.number().int().min(1).max(SEATS_MAX),
});

function mapError(error: unknown): never {
  if (error instanceof LedgerError) {
    const m = LEDGER_HTTP[error.code];
    throw new HttpError(m.code as KnownErrorCode, error.message || m.message);
  }
  throw error;
}

export function subscriptionRoutes(s: ClientServices): Hono<ClientEnv> {
  return new Hono<ClientEnv>()
    .post('/', jsonBody(purchaseSchema), async (c) => {
      const session = c.get('session');
      const body = c.req.valid('json');
      try {
        // 团队套餐（allowSeats）：组织在账本事务内创建（T3）——路由层预建会在失败时
        // 留孤儿 org，且重放时新 org 改变指纹 → 409，幂等性失效。
        const result = await s.ledger.subscribePlan({
          operationId: operationId(c),
          userId: session.userId,
          planId: body.planId,
          quantity: body.quantity ?? 1,
          ensureOrg: true,
        });
        return c.json(result, 201);
      } catch (error) {
        mapError(error);
      }
    })

    .post('/:id/change', jsonBody(changeSchema), async (c) => {
      const session = c.get('session');
      const id = intParam(c, 'id');
      const body = c.req.valid('json');
      try {
        const result = await s.ledger.changeSubscription({
          operationId: operationId(c),
          subscriptionId: id,
          targetPlanId: body.targetPlanId,
          quantity: body.quantity,
          userId: session.userId, // 限定自己的订阅
        });
        return c.json(result);
      } catch (error) {
        mapError(error);
      }
    })

    .post('/:id/renew', async (c) => {
      const session = c.get('session');
      const id = intParam(c, 'id');
      try {
        const result = await s.ledger.renewSubscription({
          operationId: operationId(c),
          subscriptionId: id,
          userId: session.userId, // 限定自己的订阅
        });
        return c.json(result);
      } catch (error) {
        mapError(error);
      }
    });
}
