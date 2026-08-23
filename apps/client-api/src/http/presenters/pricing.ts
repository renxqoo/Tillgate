/**
 * 定价呈现：目录富化行 ×（可选）用户费率卡系数 → 公开/个性化价格行。
 * 到手价 = 官方价 × pickCoefficient（model > group > global > 1，billing 单源）。
 */
import { Decimal, pickCoefficient, type RateCardCoefficientSnapshot } from '@tokenlens/billing';

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
  /** 登录态富化：费率卡系数与到手价 */
  coefficient?: string;
  effective?: { inputPrice: string; outputPrice: string; cacheInputPrice: string; unitPrice: string };
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
    };
  });
}

export function toPersonalPricingRows(
  catalog: BaseCatalog,
  snapshot: RateCardCoefficientSnapshot | null,
): PublicPricingModel[] {
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
      coefficient,
      effective: {
        inputPrice: times(inputPrice),
        outputPrice: times(outputPrice),
        cacheInputPrice: times(cacheInputPrice),
        unitPrice: times(unitPrice),
      },
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
