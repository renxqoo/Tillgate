/**
 * 定价读面（gateway catalog-port 同款的 app-face join）：control-plane 只读目录
 * store + billing pickCoefficient 快照形态转换 + Redis 共享缓存（多副本一份，
 * 30s 可配；缓存故障 fail-open 直查库——v1 语义）。
 */
import type { Redis } from 'ioredis';
import type { Db } from '@tokenlens/db';
import { postgresModelStore, postgresRateCardStore } from '@tokenlens/control-plane/composition';
import type { RateCardCoefficientSnapshot } from '@tokenlens/billing';
import type { BaseCatalog, PricingEnrichedRow } from '../http/presenters/pricing.js';

/** 缓存键带版本号——目录形状变更时递增失效存量 */
const CACHE_KEY = 'client:pricing:catalog:v1';

export interface PricingRead {
  baseCatalog(): Promise<BaseCatalog>;
  rateCardSnapshot(userId: number): Promise<RateCardCoefficientSnapshot | null>;
}

/** UserRateCardContext（control-plane）→ pickCoefficient 快照（billing 纯函数入参） */
function toSnapshot(ctx: {
  cardId: number;
  status: number;
  coefficients: ReadonlyArray<{
    scope: 'model' | 'group' | 'global';
    modelMappingId: number | null;
    groupKey: string | null;
    coefficient: string;
  }>;
}): RateCardCoefficientSnapshot {
  const snapshot: RateCardCoefficientSnapshot = {
    rateCardId: ctx.cardId,
    status: ctx.status,
    global: null,
    model: {},
    group: {},
  };
  for (const c of ctx.coefficients) {
    if (c.scope === 'global') snapshot.global = c.coefficient;
    else if (c.scope === 'model' && c.modelMappingId != null)
      snapshot.model[c.modelMappingId] = c.coefficient;
    else if (c.scope === 'group' && c.groupKey != null) snapshot.group[c.groupKey] = c.coefficient;
  }
  return snapshot;
}

export function createPricingRead(
  db: Db,
  redis: Redis,
  options: { cacheTtlMs: number },
): PricingRead {
  const ttlSeconds = Math.max(1, Math.ceil(options.cacheTtlMs / 1000));

  async function loadCatalog(): Promise<BaseCatalog> {
    const models = await postgresModelStore.listEnabledMappings(db);
    const enriched = await postgresModelStore.findActiveByExternalNames(
      db,
      models.map((m) => m.externalName),
    );
    return { models, enriched };
  }

  return {
    async baseCatalog() {
      // 缓存故障 fail-open：任何 redis 异常吞掉直查库（v1 语义）
      try {
        const cached = await redis.get(CACHE_KEY);
        if (cached != null) {
          const parsed = JSON.parse(cached) as {
            models: BaseCatalog['models'];
            enriched: [string, PricingEnrichedRow][];
          };
          return { models: parsed.models, enriched: new Map(parsed.enriched) };
        }
      } catch {
        // fall through 直查
      }
      const catalog = await loadCatalog();
      try {
        await redis.set(
          CACHE_KEY,
          JSON.stringify({ models: catalog.models, enriched: [...catalog.enriched.entries()] }),
          'EX',
          ttlSeconds,
        );
      } catch {
        // 写缓存失败不影响响应
      }
      return catalog;
    },

    async rateCardSnapshot(userId) {
      const ctx = await postgresRateCardStore.findActiveCardByUser(db, userId);
      return ctx == null ? null : toSnapshot(ctx);
    },
  };
}
