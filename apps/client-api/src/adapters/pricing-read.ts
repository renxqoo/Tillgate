/**
 * 定价读面（gateway catalog-port 同款的 app-face join）：control-plane 只读目录
 * store + billing pickCoefficient 快照形态转换 + Redis 共享缓存（多副本一份，
 * 30s 可配；缓存故障 fail-open 直查库——v1 语义）。
 * 计费时区同源 system_configs（进程内 TTL 缓存；目录形状 v2 = 富化行带分时段窗口）。
 */
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Db } from '@tillgate/db';
import { systemConfigs } from '@tillgate/db';
import { postgresModelStore, postgresRateCardStore } from '@tillgate/control-plane/composition';
import type { RateCardCoefficientSnapshot } from '@tillgate/billing';
import type { BaseCatalog, PricingEnrichedRow } from '../http/presenters/pricing.js';
import { scheduleWindowsOf } from '../http/presenters/pricing.js';

/** 缓存键带版本号——目录形状变更时递增失效存量（v2 = 富化行带 schedule 窗口） */
const CACHE_KEY = 'client:pricing:catalog:v2';

/** system_configs 计费时区键（与网关热路径读取器、admin settings 路由同一约定） */
const BILLING_TIMEZONE_KEY = 'billing_timezone';

export interface PricingRead {
  baseCatalog(): Promise<BaseCatalog>;
  rateCardSnapshot(userId: number): Promise<RateCardCoefficientSnapshot | null>;
  /** 计费时区（未配置回落缺省——定价页时段说明的墙钟口径） */
  billingTimezone(): Promise<string>;
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
    else if (c.scope === 'model' && c.modelMappingId != null) {
      snapshot.model[c.modelMappingId] = c.coefficient;
    } else if (c.scope === 'group' && c.groupKey != null) {
      snapshot.group[c.groupKey] = c.coefficient;
    }
  }
  return snapshot;
}

// eslint-disable-next-line max-lines-per-function -- 价格读模型工厂:目录投影/缓存方法的列映射平铺(缓存缝共享 db/redis 闭包)
export function createPricingRead(
  db: Db,
  redis: Redis,
  options: { cacheTtlMs: number; timezoneTtlMs: number; timezoneFallback: string },
): PricingRead {
  const ttlSeconds = Math.max(1, Math.ceil(options.cacheTtlMs / 1000));

  async function loadCatalog(): Promise<BaseCatalog> {
    const models = await postgresModelStore.listEnabledMappings(db);
    const enriched = await postgresModelStore.findActiveByExternalNames(
      db,
      models.map((m) => m.externalName),
    );
    // ActiveMappingRow → 富化投影（billingConfig → schedule 窗口；缓存形状 = v2）
    const projected = new Map<string, PricingEnrichedRow>();
    for (const [name, row] of enriched.entries()) {
      const schedule = scheduleWindowsOf(row.billingConfig);
      projected.set(name, {
        id: row.id,
        contextLength: row.contextLength,
        inputPrice: row.inputPrice,
        outputPrice: row.outputPrice,
        cacheInputPrice: row.cacheInputPrice,
        unitPrice: row.unitPrice,
        isFree: row.isFree,
        pricingGroup: row.pricingGroup,
        ...(schedule != null ? { schedule } : {}),
      });
    }
    return { models, enriched: projected };
  }

  // 计费时区：低频变更 KV，进程内 TTL 缓存（与网关同键同值；读失败 fail-loud）
  let cachedTimezone: string | null = null;
  let cachedTimezoneAt = 0;
  async function readTimezone(): Promise<string> {
    if (cachedTimezone != null && Date.now() - cachedTimezoneAt < options.timezoneTtlMs) {
      return cachedTimezone;
    }
    const row = await db.query.systemConfigs.findFirst({
      where: eq(systemConfigs.key, BILLING_TIMEZONE_KEY),
      columns: { value: true },
    });
    const value = (row?.value ?? null) as { timezone?: unknown } | null;
    const timezone =
      typeof value?.timezone === 'string' && value.timezone.length > 0
        ? value.timezone
        : options.timezoneFallback;
    cachedTimezone = timezone;
    cachedTimezoneAt = Date.now();
    return timezone;
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

    async billingTimezone() {
      return readTimezone();
    },
  };
}
