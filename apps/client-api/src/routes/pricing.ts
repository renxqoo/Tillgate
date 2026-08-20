/**
 * 公开模型定价（无会话——价格目录是公共信息；登录墙外价格页/Playground 用）。
 * 输出 v1 兼容形状（含价格三元组），费率卡系数在网关侧按用户卡解析——此处是官方价。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
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
  /** 登录态富化（v1 GET /api/pricing 对位）：费率卡系数与到手价 */
  coefficient?: string;
  effective?: { inputPrice: string; outputPrice: string; cacheInputPrice: string; unitPrice: string };
  personalized?: boolean;
  rateCardStatus?: number | null;
}

/** 公开目录基础数据（模型清单 + 价格富化）的进程内 TTL 缓存：
 *  价格目录是公共信息、变更由运营驱动——30s 传播延迟无感，而每次命中省两查 DB
 *  （公开无会话端点，爬虫/价格页刷屏不再直压数据库）。多副本各自缓存，短 TTL 天然收敛。 */
const BASE_CATALOG_TTL_MS = 30_000;

export function pricingRoutes(
  db: Db,
  repos: Repositories = createRepositories(),
  session?: MiddlewareHandler<SessionEnv>,
  opts: { cacheTtlMs?: number } = {},
) {
  const app = new Hono();
  const ctx = { requestId: 'pricing', actor: { kind: 'system' } as const, traceParent: null };
  const ttlMs = opts.cacheTtlMs ?? BASE_CATALOG_TTL_MS;

  type CatalogModels = Awaited<ReturnType<typeof repos.modelMapping.listEnabledModels>>;
  type CatalogEnriched = Awaited<ReturnType<typeof repos.modelMapping.findActiveByExternalNames>>;
  let baseCache: { at: number; models: CatalogModels; enriched: CatalogEnriched } | null = null;

  async function loadBaseCatalog(): Promise<{ models: CatalogModels; enriched: CatalogEnriched }> {
    if (baseCache && Date.now() - baseCache.at < ttlMs) return baseCache;
    const models = await repos.modelMapping.listEnabledModels({ db, ...ctx });
    const enriched = await repos.modelMapping.findActiveByExternalNames(
      { db, ...ctx },
      models.map((m) => m.externalName),
    );
    baseCache = { at: Date.now(), models, enriched };
    return baseCache;
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

  app.get('/v1/pricing', async (c) => c.json({ models: await buildRows() }));

  // 个性化价格（v1 GET /api/pricing 对位）：费率卡系数 × 官方价 = 到手价
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
      return c.json({ models: rows });
    });
  }

  return app;
}
