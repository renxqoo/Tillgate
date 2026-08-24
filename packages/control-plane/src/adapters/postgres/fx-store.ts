/**
 * fx_rates 目录汇率 postgres 适配器（v1 fx.repo 等价迁移，减 TTL 缓存——B4：
 * admin 语义恒直读追加表；进程内缓存只服务网关热路径，归 inference 波次）。
 */
import { and, desc, eq } from 'drizzle-orm';
import type { DbLike } from '@tillgate/db';
import { fxRates, systemConfigs } from '@tillgate/db';
import type { FxStore, FxCurrentRow } from '../../ports/fx-store';
import { trimNumeric } from '../../domain/fx/fx-rates';

/** catalog_fx 缓存视图键（system_configs；真相在 fx_rates 与审计） */
export const CATALOG_FX_CONFIG_KEY = 'catalog_fx';

interface FxConfigShape {
  mode: 'auto' | 'override';
  overrideRate: string | null;
}

async function loadCurrent(db: DbLike): Promise<FxCurrentRow | null> {
  const config = await db.query.systemConfigs.findFirst({
    where: eq(systemConfigs.key, CATALOG_FX_CONFIG_KEY),
    columns: { value: true },
  });
  const shape = (config?.value ?? null) as FxConfigShape | null;
  if (shape?.mode === 'override' && shape.overrideRate != null) {
    const manual = await db.query.fxRates.findFirst({
      where: and(eq(fxRates.mode, 'override')),
      orderBy: [desc(fxRates.id)],
      columns: { id: true, rate: true, fetchedAt: true },
    });
    // 覆盖态以追加表最近 manual 行为准（配置只是缓存视图）
    if (manual) {
      return {
        rate: trimNumeric(manual.rate),
        fxRateId: manual.id,
        source: 'manual',
        fetchedAt: manual.fetchedAt.toISOString(),
      };
    }
  }
  const latest = await db.query.fxRates.findFirst({
    where: eq(fxRates.mode, 'auto'),
    orderBy: [desc(fxRates.id)],
    columns: { id: true, rate: true, source: true, fetchedAt: true },
  });
  if (!latest) return null;
  return {
    rate: trimNumeric(latest.rate),
    fxRateId: latest.id,
    source: latest.source,
    fetchedAt: latest.fetchedAt.toISOString(),
  };
}

export const postgresFxStore: FxStore = {
  async current(db) {
    return loadCurrent(db);
  },

  async insertRate(db, input) {
    // fx_rates 只增不改——auto 拉取与 manual 覆盖共用
    const [row] = await db
      .insert(fxRates)
      .values({
        rate: input.rate,
        source: input.source,
        mode: input.mode,
        operatorAdminId: input.operatorAdminId ?? null,
      })
      .returning({ id: fxRates.id });
    return { id: row!.id };
  },

  async readConfig(db) {
    const row = await db.query.systemConfigs.findFirst({
      where: eq(systemConfigs.key, CATALOG_FX_CONFIG_KEY),
      columns: { value: true },
    });
    return (row?.value as Record<string, unknown> | undefined) ?? null;
  },

  async upsertConfig(db, input) {
    await db
      .insert(systemConfigs)
      .values({ key: CATALOG_FX_CONFIG_KEY, value: input.value, updatedByAdminId: input.adminId })
      .onConflictDoUpdate({
        target: systemConfigs.key,
        set: { value: input.value, updatedAt: new Date(), updatedByAdminId: input.adminId },
      });
  },
};
