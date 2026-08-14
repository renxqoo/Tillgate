import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { jsonBody } from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import { modelMappings } from '@ai-gateway/db/schema';
import type { AdminServices } from '../services/index.js';
import { channels as channelsTable } from '@ai-gateway/db/schema';
import {
  compareCatalog,
  importCatalogModels,
  mapOpenRouterCatalog,
  OPENROUTER_BASE_URL,
  OPENROUTER_FREE_CHANNEL,
} from '../services/model-catalog.js';

/**
 * 模型目录（免费模型一键入库）：
 *   GET  /openrouter  拉取 OpenRouter 免费模型（内存缓存 10min），比对库内
 *                     已导入状态与价格漂移（上游收费而我们仍 0 卖 → 标红）
 *   POST /import      勾选模型 + 平台 key → 复用现有三层落库（护栏见 service）
 */

const importSchema = z.object({
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
let cache: { fetchedAt: number; raw: unknown } | null = null;

async function fetchOpenRouterModels(): Promise<{ fetchedAt: number; raw: unknown }> {
  if (cache && Date.now() - cache.fetchedAt < CATALOG_CACHE_TTL_MS) {
    return { fetchedAt: cache.fetchedAt, raw: cache.raw };
  }
  const res = await fetch(`${OPENROUTER_BASE_URL}/v1/models`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    // 拉取失败时若有旧缓存则降级返回（带旧时间戳，页面可提示数据新鲜度）
    if (cache) return { fetchedAt: cache.fetchedAt, raw: cache.raw, stale: true } as {
      fetchedAt: number;
      raw: unknown;
    };
    throw new Error(`openrouter catalog fetch failed: ${res.status}`);
  }
  const raw = await res.json();
  cache = { fetchedAt: Date.now(), raw };
  return cache;
}

export function modelCatalogRoutes(s: AdminServices): Hono<AdminEnv> {
  return new Hono<AdminEnv>()
    .get('/openrouter', async (c) => {
      const { fetchedAt, raw } = await fetchOpenRouterModels();
      const items = mapOpenRouterCatalog(raw);
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
      // 免费渠道是否已存在：首次导入需要平台 key（前端据此显隐 key 输入）
      const freeChannel = await s.db.query.channels.findFirst({
        where: eq(channelsTable.name, OPENROUTER_FREE_CHANNEL),
      });
      return c.json({
        fetchedAt: new Date(fetchedAt).toISOString(),
        source: 'openrouter',
        channelReady: freeChannel != null,
        channelRpmLimit: freeChannel?.rpmLimit ?? null,
        items: compareCatalog(items, existing),
      });
    })
    .post('/import', jsonBody(importSchema), async (c) => {
      const body = c.req.valid('json');
      const result = await importCatalogModels(s, {
        apiKey: body.apiKey,
        models: body.models,
      });
      return c.json(result);
    });
}
