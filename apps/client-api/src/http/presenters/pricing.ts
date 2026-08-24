/**
 * 定价呈现：目录富化行 ×（可选）用户费率卡系数 → 公开/个性化价格行。
 * 到手价 = 官方价 × pickCoefficient（model > group > global > 1，billing 单源）。
 */
import { Decimal, pickCoefficient, type RateCardCoefficientSnapshot } from '@tillgate/billing';

/** pricing-read 产出的目录富化行（control-plane ActiveMappingRow 的价格投影） */
export interface PricingEnrichedRow {
  id: number;
  contextLength: number | null;
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  unitPrice: string;
  isFree: boolean;
  pricingGroup: string | null;
  /** 分时段窗口（billingConfig strategy=schedule；未配置 = undefined） */
  schedule?: PublicScheduleWindow[];
}

/** 公开时段窗口（未覆盖价格轴不出场——回落基价展示） */
export interface PublicScheduleWindow {
  label?: string;
  start: string;
  end: string;
  inputPrice?: string;
  outputPrice?: string;
  cacheInputPrice?: string;
  unitPrice?: string;
}

/** billingConfig（DB JSONB）→ 公开窗口表（schedule 之外 / 空表 / 缺参 → undefined） */
export function scheduleWindowsOf(billingConfig?: unknown): PublicScheduleWindow[] | undefined {
  const cfg = billingConfig as
    | { strategy?: string; params?: { windows?: unknown[] } }
    | null
    | undefined;
  if (cfg?.strategy !== 'schedule' || !Array.isArray(cfg.params?.windows)) return undefined;
  const windows = cfg.params.windows as Array<Record<string, unknown>>;
  if (windows.length === 0) return undefined;
  return windows.map((w) => ({
    ...(typeof w.label === 'string' && w.label !== '' ? { label: w.label } : {}),
    start: String(w.start),
    end: String(w.end),
    ...(typeof w.inputPrice === 'string' ? { inputPrice: w.inputPrice } : {}),
    ...(typeof w.outputPrice === 'string' ? { outputPrice: w.outputPrice } : {}),
    ...(typeof w.cacheInputPrice === 'string' ? { cacheInputPrice: w.cacheInputPrice } : {}),
    ...(typeof w.unitPrice === 'string' ? { unitPrice: w.unitPrice } : {}),
  }));
}

/** 公开价格目录行（realModel 是上游路由内部信息，不进公开面） */
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
  /** 分时段窗口（schedule 策略；基价为未命中时段的缺省价） */
  schedule?: PublicScheduleWindow[];
  /** 登录态富化：费率卡系数与到手价 */
  coefficient?: string;
  effective?: {
    inputPrice: string;
    outputPrice: string;
    cacheInputPrice: string;
    unitPrice: string;
  };
  /** 登录态富化：各窗口到手价（窗口官方价 × 系数） */
  effectiveSchedule?: PublicScheduleWindow[];
  personalized?: boolean;
  rateCardStatus?: number | null;
}

export interface BaseCatalogModel {
  externalName: string;
  realModel: string;
  pricingUnit: string;
}

export interface BaseCatalog {
  models: readonly BaseCatalogModel[];
  enriched: ReadonlyMap<string, PricingEnrichedRow>;
}

export function toPublicPricingRows(catalog: BaseCatalog): PublicPricingModel[] {
  // eslint-disable-next-line complexity -- 公开价格行投影的逐字段空值兜底平铺(分支即字段映射)
  return catalog.models.map((m) => {
    const full = catalog.enriched.get(m.externalName);
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
      ...(full?.schedule != null ? { schedule: full.schedule } : {}),
    };
  });
}

/** 窗口官方价 × 系数 → 各轴到手价（未覆盖轴不出场——与窗口官方价同形） */
function effectiveWindowsOf(
  windows: PublicScheduleWindow[],
  times: (v: string) => string,
): PublicScheduleWindow[] {
  return windows.map((w) => ({
    ...w,
    ...(w.inputPrice != null ? { inputPrice: times(w.inputPrice) } : {}),
    ...(w.outputPrice != null ? { outputPrice: times(w.outputPrice) } : {}),
    ...(w.cacheInputPrice != null ? { cacheInputPrice: times(w.cacheInputPrice) } : {}),
    ...(w.unitPrice != null ? { unitPrice: times(w.unitPrice) } : {}),
  }));
}

export function toPersonalPricingRows(
  catalog: BaseCatalog,
  snapshot: RateCardCoefficientSnapshot | null,
): PublicPricingModel[] {
  // eslint-disable-next-line complexity -- 个人化价格行投影+系数挑选,分支即字段映射与三档系数兜底
  return catalog.models.map((m) => {
    const full = catalog.enriched.get(m.externalName);
    const inputPrice = full?.inputPrice ?? '0';
    const outputPrice = full?.outputPrice ?? '0';
    const cacheInputPrice = full?.cacheInputPrice ?? '0';
    const unitPrice = full?.unitPrice ?? '0';
    const coefficient = pickCoefficient(snapshot, {
      modelMappingId: full?.id ?? null,
      pricingGroup: full?.pricingGroup ?? null,
    });
    const times = (v: string) => new Decimal(v).times(coefficient).toString();
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
      ...(full?.schedule != null ? { schedule: full.schedule } : {}),
      coefficient,
      effective: {
        inputPrice: times(inputPrice),
        outputPrice: times(outputPrice),
        cacheInputPrice: times(cacheInputPrice),
        unitPrice: times(unitPrice),
      },
      ...(full?.schedule != null
        ? { effectiveSchedule: effectiveWindowsOf(full.schedule, times) }
        : {}),
      personalized: snapshot != null,
      rateCardStatus: snapshot?.status ?? null,
    };
  });
}

/** 目录过滤 + 切页（q/free；返回体带分页元数据——total 供 Pager） */
export function slicePricingCatalog<T extends { externalName: string; isFree: boolean }>(
  rows: readonly T[],
  query: { q: string; free: boolean | null; page: number; pageSize: number },
): { models: T[]; total: number; page: number; pageSize: number } {
  const filtered = rows.filter((r) => {
    if (query.q !== '' && !r.externalName.toLowerCase().includes(query.q)) return false;
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
