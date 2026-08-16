import { Hono } from 'hono';
import { z } from 'zod';
import { intParam, jsonBody, query, listQuerySchema } from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import type { AdminServices } from '../services/index.js';
import {
  createRateCard, deleteRateCard, fmtCoeff, listRateCards, listRateCardUsers, rateCardHealth, updateRateCard,
} from '../services/rate-cards.js';

/**
 * 费率卡管理（api-contract §4.9）。
 *
 * 定价模型：用户价 = 官方价（model_mappings）× 费率卡系数。
 *   - 每张卡必有且仅有一行 scope=global 兜底系数（应用层保证，data-model §3.9）
 *   - 系数合法范围 [0, 9.999]（numeric(6,3) 上限；负数/超大拒绝）
 *   - 删除仅当无用户绑定时允许（防孤儿账户）
 */

const rateCardCreateSchema = z.object({
  name: z.string().min(1).max(32),
  description: z.string().max(255).optional(),
  /** 全局兜底系数，必填，范围 [0, 9.999] */
  coefficient: z.number().min(0).max(9.999),
});

const rateCardUpdateSchema = z.object({
  name: z.string().min(1).max(32).optional(),
  description: z.string().max(255).nullable().optional(),
  /** 0 启用 / 1 停用 */
  status: z.number().int().min(0).max(1).optional(),
  /** 更新全局系数（可选） */
  coefficient: z.number().min(0).max(9.999).optional(),
});

export function rateCardAdminRoutes(s: AdminServices): Hono<AdminEnv> {
  return (
    new Hono<AdminEnv>()

      // 列表（附 global 系数）
      .get('/', query(listQuerySchema), async (c) =>
        c.json(await listRateCards(s, c.req.valid('query'))),
      )

      // 创建（必须带全局系数，事务见 service）
      .post('/', jsonBody(rateCardCreateSchema), async (c) => {
        const body = c.req.valid('json');
        const card = await createRateCard(s, body, c.get('adminId'));
        return c.json({ ...card, coefficient: fmtCoeff(body.coefficient) }, 201);
      })

      // 更新（名称/描述/状态/全局系数）
      .patch('/:id', jsonBody(rateCardUpdateSchema), async (c) => {
        const id = intParam(c, 'id');
        const updated = await updateRateCard(s, id, c.req.valid('json'), c.get('adminId'));
        return c.json(updated);
      })

      // 查看绑定该卡的账户（api-contract §4.9）
      .get('/:id/users', query(listQuerySchema), async (c) =>
        c.json(await listRateCardUsers(s, intParam(c, 'id'), c.req.valid('query'))),
      )

      // 删除：仅当无用户绑定时允许（防误删导致账户孤儿，见 service）
      .delete('/:id', async (c) => {
        await deleteRateCard(s, intParam(c, 'id'), c.get('adminId'));
        return c.json({ ok: true });
      })

      // 健康自检：全局系数行是否存在（data-model §3.9 约束校验）
      .get('/:id/health', async (c) => c.json(await rateCardHealth(s, intParam(c, 'id'))))
  );
}
