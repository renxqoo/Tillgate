/**
 * 公开模型定价（无会话——价格目录是公共信息；登录墙外价格页/Playground 用）。
 * 输出 v1 兼容形状（含价格三元组），费率卡系数在网关侧按用户卡解析——此处是官方价。
 */
import { Hono } from 'hono';
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type Repositories } from '@ai-gateway/repository';

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
}

export function pricingRoutes(db: Db, repos: Repositories = createRepositories()) {
  const app = new Hono();
  const ctx = { requestId: 'pricing', actor: { kind: 'system' } as const, traceParent: null };

  app.get('/v1/pricing', async (c) => {
    const models = await repos.modelMapping.listEnabledModels({ db, ...ctx });
    const enriched = await repos.modelMapping.findActiveByExternalNames(
      { db, ...ctx },
      models.map((m) => m.externalName),
    );
    const rows: PublicPricingModel[] = models.map((m) => {
      const full = enriched.get(m.externalName);
      return {
        id: full?.id ?? 0,
        externalName: m.externalName,
        contextLength: null,
        pricingUnit: m.pricingUnit,
        inputPrice: full?.inputPrice ?? '0',
        outputPrice: full?.outputPrice ?? '0',
        cacheInputPrice: full?.cacheInputPrice ?? '0',
        unitPrice: full?.unitPrice ?? '0',
        isFree: full?.isFree ?? false,
      };
    });
    return c.json({ models: rows });
  });

  return app;
}
