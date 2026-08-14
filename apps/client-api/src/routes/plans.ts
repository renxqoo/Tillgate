import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { plans } from '@ai-gateway/db/schema';
import type { ClientEnv } from '@ai-gateway/identity';
import type { ClientServices } from '../services/index.js';

/**
 * 用户面板：可购套餐列表（api-contract §4.9）。
 * 只返回上架（status=0）的「包月」套餐（kind=subscription）；加油包仅管理员发放，不对用户开放。
 * 金额额度 + 售价均为元，积分由前端展示层换算。
 */
export function planRoutes(s: ClientServices): Hono<ClientEnv> {
  return new Hono<ClientEnv>().get('/', async (c) => {
    const rows = await s.db
      .select()
      .from(plans)
      .where(and(eq(plans.status, 0), eq(plans.kind, 'subscription')))
      .orderBy(plans.id);
    return c.json({ list: rows, total: rows.length });
  });
}
