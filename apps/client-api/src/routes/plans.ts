import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { plans } from '@ai-gateway/db/schema';
import {
  paginateQuery, query, listQuerySchema, buildList, countAll } from '@ai-gateway/http';
import type { ClientEnv } from '@ai-gateway/identity';
import type { ClientServices } from '../services/index.js';

/**
 * 用户面板：可购套餐列表（api-contract §4.9）。
 * 只返回上架（status=0）的「包月」套餐（kind=subscription）；加油包仅管理员发放，不对用户开放。
 * 金额额度 + 售价均为元，积分由前端展示层换算。
 */
export function planRoutes(s: ClientServices): Hono<ClientEnv> {
  return new Hono<ClientEnv>().get(
    '/',
    query(listQuerySchema),
    async (c) => {
      const input = c.req.valid('query');
      const { page, limit, offset, where, orderBy } = buildList(input, {
        search: [plans.name],
        conditions: [eq(plans.status, 0), eq(plans.kind, 'subscription')],
        // plans 无 created_at，默认 id desc；购买页按 sortOrder asc 显式排序
        sort: {
          by: { id: plans.id, name: plans.name, price: plans.price, sortOrder: plans.sortOrder },
          fallback: 'id',
          tiebreaker: plans.id,
        },
      });
      return c.json(
        await paginateQuery(
          page,
          s.db.select().from(plans).where(where).orderBy(...orderBy).limit(limit).offset(offset),
          countAll(s.db, plans, where),
        ),
      );
    },
  );
}
