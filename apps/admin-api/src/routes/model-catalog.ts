import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { jsonBody } from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import { channels as channelsTable, modelMappings } from '@ai-gateway/db/schema';
import type { AdminServices } from '../services/index.js';
import {
  CATALOG_SOURCES,
  compareCatalog,
  getCatalogSource,
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
        inputPrice: z.coerce.number().min(0),
        outputPrice: z.coerce.number().min(0),
        cacheInputPrice: z.coerce.number().min(0),
        contextLength: z.coerce.number().int().positive().nullable().optional(),
      }),
    )
    .min(1),
});

const CATALOG_CACHE_TTL_MS = 10 * 60 * 1000;
const sourceCaches = new Map<string, { fetchedAt: number; raw: unknown }>();

async function fetchSourceModels(sourceId: string): Promise<{ fetchedAt: number; raw: unknown }> {
  const source = getCatalogSource(sourceId);
  const cached = sourceCaches.get(sourceId);
  if (cached && Date.now() - cached.fetchedAt < CATALOG_CACHE_TTL_MS) {
    return { fetchedAt: cached.fetchedAt, raw: cached.raw };
  }
  const raw = await source.fetchModels();
  const entry = { fetchedAt: Date.now(), raw };
  sourceCaches.set(sourceId, entry);
  return entry;
}

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
    .get('/:sourceId', async (c) => {
      const source = getCatalogSource(c.req.param('sourceId'));
      const { fetchedAt, raw } = await fetchSourceModels(source.id);
      const items = source.mapModels(raw);
      // 比对库内：按真实模型名回填已导入卖价与漂移警告
      const reals = items.map((i) => i.realModel);
      const existing =
        reals.length > 0
          ? await s.db
              .select({
                externalName: modelMappings.externalName,
                realModel: modelMappings.realModel,
                inputPrice: modelMappings.inputPrice,
                outputPrice: modelMappings.outputPrice,
              })
              .from(modelMappings)
              .where(eq(modelMappings.status, 0))
              .then((rows) => rows.filter((r) => reals.includes(r.realModel)))
          : [];
      // 该源免费渠道是否已存在：首次导入需要平台 key（前端据此显隐 key 输入）
      const freeChannel = await s.db.query.channels.findFirst({
        where: eq(channelsTable.name, source.channelName),
      });
      return c.json({
        source: source.id,
        fetchedAt: new Date(fetchedAt).toISOString(),
        channelReady: freeChannel != null,
        channelRpmLimit: freeChannel?.rpmLimit ?? null,
        items: compareCatalog(items, existing),
      });
    })
    .post('/import', jsonBody(importSchema), async (c) => {
      const body = c.req.valid('json');
      const result = await importCatalogModels(s, {
        sourceId: body.sourceId,
        apiKey: body.apiKey,
        models: body.models,
      });
      return c.json(result);
    });
}
