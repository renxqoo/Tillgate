import { Hono } from 'hono';
import { z } from 'zod';
import {
  MONEY_MAX, jsonBody } from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import type { AdminServices } from '../services/index.js';
import {
  CATALOG_SOURCES,
  getCatalogComparison,
  importCatalogModels,
} from '../services/model-catalog.js';

/**
 * 模型市场目录（多源）：
 *   GET  /sources            可用目录源列表（前端 Tab）
 *   GET  /:sourceId          该源免费模型（源内 10min 缓存），比对已导入与价格漂移
 *   POST /import             勾选模型 + 平台 key → 复用现有三层落库（护栏见 service）
 * 新增源：services/model-catalog.ts 的 CATALOG_SOURCES 注册 adapter 即可。
 */

const importSchema = z.object({
  sourceId: z.string().min(1).max(32),
  apiKey: z.string().min(1).optional(),
  models: z
    .array(
      z.object({
        externalName: z.string().min(1).max(64),
        realModel: z.string().min(1).max(128),
        inputPrice: z.coerce.number().min(0).finite().max(MONEY_MAX),
        outputPrice: z.coerce.number().min(0).finite().max(MONEY_MAX),
        cacheInputPrice: z.coerce.number().min(0).finite().max(MONEY_MAX),
        contextLength: z.coerce.number().int().positive().nullable().optional(),
      }),
    )
    .min(1),
});

export function modelCatalogRoutes(s: AdminServices): Hono<AdminEnv> {
  return new Hono<AdminEnv>()
    .get('/sources', (c) => {
      return c.json({
        sources: Object.values(CATALOG_SOURCES).map((src) => ({
          id: src.id,
          name: src.name,
          needsKey: src.needsKey,
          channelName: src.channelName,
        })),
      });
    })
    .get('/:sourceId', async (c) =>
      c.json(await getCatalogComparison(s, c.req.param('sourceId'))),
    )

    .post('/import', jsonBody(importSchema), async (c) => {
      const body = c.req.valid('json');
      const result = await importCatalogModels(s, {
        sourceId: body.sourceId,
        apiKey: body.apiKey,
        models: body.models,
        adminId: c.get('adminId') ?? null,
      });
      return c.json(result);
    });
}
