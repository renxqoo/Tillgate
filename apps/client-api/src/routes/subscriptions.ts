import { Hono } from 'hono';
import { z } from 'zod';
import { HttpError, jsonBody, operationId } from '@ai-gateway/http';
import { LedgerError } from '@ai-gateway/ledger';
import type { ClientEnv } from '@ai-gateway/identity';
import type { ClientServices } from '../services/index.js';

/**
 * 用户面板：套餐购买/变更（api-contract §4.9）。
 *   - POST /：用余额购买（扣余额、开订阅期），quantity=席位（默认 1）
 *   - POST /:id/change：升级/加席位（补差价，只能升不能降）
 *   - POST /:id/renew：续费（按原席位扣余额、旧订阅转到期、新订阅顺延）
 */
const purchaseSchema = z.object({
  planId: z.number().int().positive(),
  quantity: z.number().int().min(1).optional(),
});

const changeSchema = z.object({
  targetPlanId: z.number().int().positive(),
  quantity: z.number().int().min(1),
});

function mapError(error: unknown): never {
  if (error instanceof LedgerError) {
    switch (error.code) {
      case 'already_subscribed':
        throw new HttpError(409, 'ALREADY_SUBSCRIBED', '已有有效订阅，请先取消或续费');
      case 'plan_not_found':
        throw new HttpError(404, 'PLAN_NOT_FOUND', '套餐不存在');
      case 'no_subscription':
        throw new HttpError(404, 'NO_SUBSCRIPTION', '订阅不存在或已失效');
      case 'plan_disabled':
        throw new HttpError(400, 'PLAN_DISABLED', '套餐已停用，无法购买');
      case 'downgrade_not_allowed':
        throw new HttpError(409, 'DOWNGRADE_NOT_ALLOWED', '只能升级或加席位，不支持降级/缩容');
      case 'invalid_quantity':
        throw new HttpError(400, 'INVALID_QUANTITY', '席位数量必须为 >=1 的整数');
      case 'seats_not_allowed':
        throw new HttpError(400, 'SEATS_NOT_ALLOWED', '该套餐不支持席位（个人套餐固定 1 席）');
      case 'enterprise_required':
        throw new HttpError(403, 'ENTERPRISE_REQUIRED', '团队套餐仅企业用户可购买');
      case 'insufficient_balance':
        throw new HttpError(402, 'INSUFFICIENT_BALANCE', '余额不足，无法购买套餐');
      case 'user_not_found':
        throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在');
      case 'idempotency_conflict':
        throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已被不同请求使用');
    }
  }
  throw error;
}

export function subscriptionRoutes(s: ClientServices): Hono<ClientEnv> {
  return new Hono<ClientEnv>()
    .post('/', jsonBody(purchaseSchema), async (c) => {
      const session = c.get('session');
      const body = c.req.valid('json');
      try {
        const result = await s.ledger.subscribePlan({
          operationId: operationId(c),
          userId: session.userId,
          planId: body.planId,
          quantity: body.quantity ?? 1,
        });
        return c.json(result, 201);
      } catch (error) {
        mapError(error);
      }
    })

    .post('/:id/change', jsonBody(changeSchema), async (c) => {
      const session = c.get('session');
      const id = Number(c.req.param('id'));
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
      const id = Number(c.req.param('id'));
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
