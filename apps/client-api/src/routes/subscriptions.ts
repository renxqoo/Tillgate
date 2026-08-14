import { Hono } from 'hono';
import { z } from 'zod';
import { HttpError, jsonBody, operationId } from '@ai-gateway/http';
import { LedgerError } from '@ai-gateway/ledger';
import type { ClientEnv } from '@ai-gateway/identity';
import type { ClientServices } from '../services/index.js';

/**
 * 用户面板：套餐购买（api-contract §4.9）。
 * 用余额购买套餐（扣余额、开订阅期）；余额不足 402；已有有效订阅 409。
 */
const purchaseSchema = z.object({ planId: z.number().int().positive() });

function mapError(error: unknown): never {
  if (error instanceof LedgerError) {
    switch (error.code) {
      case 'already_subscribed':
        throw new HttpError(409, 'ALREADY_SUBSCRIBED', '已有有效订阅，请先取消或续费');
      case 'plan_not_found':
        throw new HttpError(404, 'PLAN_NOT_FOUND', '套餐不存在');
      case 'plan_disabled':
        throw new HttpError(400, 'PLAN_DISABLED', '套餐已停用，无法购买');
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
  return new Hono<ClientEnv>().post('/', jsonBody(purchaseSchema), async (c) => {
    const session = c.get('session');
    const body = c.req.valid('json');
    try {
      const result = await s.ledger.subscribePlan({
        operationId: operationId(c),
        userId: session.userId,
        planId: body.planId,
      });
      return c.json(result, 201);
    } catch (error) {
      mapError(error);
    }
  });
}
