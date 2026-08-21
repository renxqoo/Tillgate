/**
 * 公开模型定价（无会话——价格目录是公共信息；登录墙外价格页/Playground 用）。
 * 输出公开目录形状（含价格三元组），费率卡系数在网关侧按用户卡解析——此处是官方价。
 * 基础目录缓存于 Redis（30s TTL，多副本共享重建；Redis 故障 fail-open 直查 DB——
 * 缓存是优化不是依赖，公共端点不因缓存层抖动不可用）。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { Redis } from 'ioredis';
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type Repositories } from '@ai-gateway/repository';
import { Decimal } from '@ai-gateway/domain';
import { pickCoefficient } from '@ai-gateway/domain';
import type { SessionEnv } from '../middleware/session.js';

/** 公开价格目录（对外名 + 价格；realModel 是上游路由内部信息，不进公开面） */
export interface PublicPricingModel {
  id: number;
  externalName: string;
  contextLength: number | null;
  pricingUnit: string;
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  unitPrice: string;
  isFree: boolean;
  /** 登录态富化：费率卡系数与到手价 */
  coefficient?: string;
  effective?: { inputPrice: string; outputPrice: string; cacheInputPrice: string; unitPrice: string };
  personalized?: boolean;
  rateCardStatus?: number | null;
}

/** 公开目录基础数据（模型清单 + 价格富化）的进程内 TTL 缓存：
 *  价格目录是公共信息、变更由运营驱动——30s 传播延迟无感，而每次命中省两查 DB
 *  （公开无会话端点，爬虫/价格页刷屏不再直压数据库）。多副本各自缓存，短 TTL 天然收敛。 */
const BASE_CATALOG_TTL_MS = 30_000;
const BASE_CATALOG_CACHE_KEY = 'pricing:catalog:v1';
/** 单页上限：目录可达数千（模型市场导入）——列表永不无界返回 */
const MAX_PAGE_SIZE = 500;
const DEFAULT_PAGE_SIZE = 100;

/** 查询参数解析（q/free/page/pageSize）；非法值回落默认而非报错——公共端点宽松语义 */
function parsePricingQuery(url: URL): { q: string; free: boolean | null; page: number; pageSize: number } {
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const freeRaw = url.searchParams.get('free');
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const pageSizeRaw = Number.parseInt(url.searchParams.get('pageSize') ?? '', 10);
  const pageSize = Number.isFinite(pageSizeRaw)
    ? Math.min(Math.max(1, pageSizeRaw), MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;
  return {
    q,
    free: freeRaw == null ? null : freeRaw === 'true' || freeRaw === '1',
    page,
    pageSize,
  };
}

/** 基础目录（已缓存）按查询过滤 + 切页；返回体带分页元数据（total 供 Pager） */
function sliceCatalog<T extends { externalName: string; isFree: boolean }>(
  rows: T[],
  query: { q: string; free: boolean | null; page: number; pageSize: number },
): { models: T[]; total: number; page: number; pageSize: number } {
  const filtered = rows.filter((r) => {
    if (query.q && !r.externalName.toLowerCase().includes(query.q)) return false;
    if (query.free === true && !r.isFree) return false;
    if (query.free === false && r.isFree) return false;
    return true;
  });
  return {
    models: filtered.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
    total: filtered.length,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export function pricingRoutes(
  db: Db,
  repos: Repositories = createRepositories(),
  session?: MiddlewareHandler<SessionEnv>,
  opts: { redis?: Redis | null; cacheTtlMs?: number } = {},
) {
  const app = new Hono();
  const ctx = { requestId: 'pricing', actor: { kind: 'system' } as const, traceParent: null };
  const ttlSeconds = Math.max(1, Math.ceil((opts.cacheTtlMs ?? BASE_CATALOG_TTL_MS) / 1000));

  type CatalogModels = Awaited<ReturnType<typeof repos.modelMapping.listEnabledModels>>;
  type CatalogEnriched = Awaited<ReturnType<typeof repos.modelMapping.findActiveByExternalNames>>;

  /** 基础目录（模型清单 + 价格富化）：Redis 共享缓存，miss 回源两查 DB 后写回。
   *  Redis 任何故障（get/set）都吞掉降级直查——缓存是优化不是依赖。 */
  async function loadBaseCatalog(): Promise<{ models: CatalogModels; enriched: CatalogEnriched }> {
    if (opts.redis) {
      const cached = await opts.redis.get(BASE_CATALOG_CACHE_KEY).catch(() => null);
      if (cached) {
        const parsed = JSON.parse(cached) as {
          models: CatalogModels;
          enriched: Array<[string, CatalogEnriched extends Map<string, infer V> ? V : never]>;
        };
        return { models: parsed.models, enriched: new Map(parsed.enriched) as CatalogEnriched };
      }
    }
    const models = await repos.modelMapping.listEnabledModels({ db, ...ctx });
    const enriched = await repos.modelMapping.findActiveByExternalNames(
      { db, ...ctx },
      models.map((m) => m.externalName),
    );
    if (opts.redis) {
      await opts.redis
        .set(
          BASE_CATALOG_CACHE_KEY,
          JSON.stringify({ models, enriched: [...enriched.entries()] }),
          'EX',
          ttlSeconds,
        )
        .catch(() => undefined);
    }
    return { models, enriched };
  }

  const buildRows = async () => {
    const { models, enriched } = await loadBaseCatalog();
    const rows: PublicPricingModel[] = models.map((m) => {
      const full = enriched.get(m.externalName);
      return {
        id: full?.id ?? 0,
        externalName: m.externalName,
        contextLength: full?.contextLength ?? null,
        pricingUnit: m.pricingUnit,
        inputPrice: full?.inputPrice ?? '0',
        outputPrice: full?.outputPrice ?? '0',
        cacheInputPrice: full?.cacheInputPrice ?? '0',
        unitPrice: full?.unitPrice ?? '0',
        isFree: full?.isFree ?? false,
      };
    });
    return rows;
  };

  app.get('/v1/pricing', async (c) => {
    const query = parsePricingQuery(new URL(c.req.url));
    return c.json(sliceCatalog(await buildRows(), query));
  });

  // 个性化价格：费率卡系数 × 官方价 = 到手价
  if (session) {
    app.get('/v1/pricing/personal', session, async (c) => {
      const userId = c.get('userId');
      const userCtx = { requestId: c.get('requestId') ?? 'pricing', actor: { kind: 'user' as const, id: userId }, traceParent: null };
      const rateCardId = await repos.user.findRateCardId({ db, ...userCtx }, userId);
      const snapshot =
        rateCardId != null
          ? await repos.rating.loadRateCardCoefficients({ db, ...userCtx }, rateCardId)
          : null;
      // 基础目录走共享缓存；仅费率卡按用户每请求解析
      const { models, enriched } = await loadBaseCatalog();
      const rows = models.map((m) => {
        const full = enriched.get(m.externalName);
        const coefficient =
          snapshot != null && full != null
            ? pickCoefficient(snapshot, {
                modelMappingId: full.id,
                pricingGroup: (full as { pricingGroup?: string | null }).pricingGroup ?? null,
              })
            : '1';
        const inputPrice = full?.inputPrice ?? '0';
        const outputPrice = full?.outputPrice ?? '0';
        const cacheInputPrice = full?.cacheInputPrice ?? '0';
        const unitPrice = full?.unitPrice ?? '0';
        return {
          id: full?.id ?? 0,
          externalName: m.externalName,
          contextLength: full?.contextLength ?? null,
          pricingUnit: m.pricingUnit,
          inputPrice,
          outputPrice,
          cacheInputPrice,
          unitPrice,
          isFree: full?.isFree ?? false,
          coefficient,
          effective: {
            inputPrice: new Decimal(inputPrice).times(coefficient).toString(),
            outputPrice: new Decimal(outputPrice).times(coefficient).toString(),
            cacheInputPrice: new Decimal(cacheInputPrice).times(coefficient).toString(),
            unitPrice: new Decimal(unitPrice).times(coefficient).toString(),
          },
          personalized: snapshot != null,
          rateCardStatus: snapshot?.status ?? null,
        };
      });
      return c.json(sliceCatalog(rows, parsePricingQuery(new URL(c.req.url))));
    });
  }

  return app;
}
