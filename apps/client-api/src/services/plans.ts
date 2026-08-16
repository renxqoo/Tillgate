import { eq } from 'drizzle-orm';
import { plans } from '@ai-gateway/db/schema';
import { z } from 'zod';
import { paginateQuery, listQuerySchema, buildList, countAll } from '@ai-gateway/http';
import type { ClientServices } from './index.js';

/**
 * 用户面板：可购套餐（api-contract §4.9）。
 * 只返回上架（status=0）的「包月」套餐（kind=subscription）；加油包仅管理员发放，不对用户开放。
 */

export async function listPurchasablePlans(s: ClientServices, input: z.infer<typeof listQuerySchema>) {
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
  return paginateQuery(
    page,
    s.db.select().from(plans).where(where).orderBy(...orderBy).limit(limit).offset(offset),
    countAll(s.db, plans, where),
  );
}
