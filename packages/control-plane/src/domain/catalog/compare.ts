/**
 * 目录 × 库内映射的三态比对与消失检测（纯函数，v1 等价迁移）。
 */
import Decimal from 'decimal.js';
import type { CatalogComparison, CatalogDiffState, CatalogItem } from './catalog';
import { toCny } from './convert';

/** 比价带宽：±5% 内视为 same（汇率与目录价的日常波动不产生噪声 diff） */
const DRIFT_BAND = new Decimal('0.05');

/**
 * 目录 × 库内映射 → 三态 diff + 回填 + 漂移警告（纯函数）。
 * USD 源需传生效汇率（null 时 diff 退化为 same——无法同币比较）。
 */
export function compareCatalog(
  items: readonly CatalogItem[],
  existing: ReadonlyArray<{
    externalName: string;
    realModel: string;
    inputPrice: string;
    outputPrice: string;
  }>,
  fx: { effectiveRate: string | null },
): CatalogComparison[] {
  const byReal = new Map(existing.map((e) => [e.realModel, e]));
  return items.map((item) => {
    const ours = byReal.get(item.realModel) ?? null;
    const catalogPromptCny = toCny(item.catalogPrompt, item.currency, fx.effectiveRate);
    const catalogCompletionCny = toCny(item.catalogCompletion, item.currency, fx.effectiveRate);
    const catalogCharged =
      new Decimal(item.catalogPrompt).gt(0) || new Decimal(item.catalogCompletion).gt(0);
    const weSellFree =
      ours != null &&
      new Decimal(ours.inputPrice).isZero() &&
      new Decimal(ours.outputPrice).isZero();

    let diff: CatalogDiffState = 'new';
    let driftPct: number | null = null;
    if (
      ours != null &&
      catalogPromptCny != null &&
      catalogCompletionCny != null &&
      catalogCharged &&
      !weSellFree
    ) {
      const oursAvg = new Decimal(ours.inputPrice).plus(ours.outputPrice).div(2);
      const catalogAvg = new Decimal(catalogPromptCny).plus(catalogCompletionCny).div(2);
      if (oursAvg.gt(0)) {
        const ratio = catalogAvg.div(oursAvg);
        driftPct = ratio.minus(1).times(100).toDecimalPlaces(1).toNumber();
        if (ratio.gt(new Decimal(1).plus(DRIFT_BAND))) diff = 'price_up';
        else if (ratio.lt(new Decimal(1).minus(DRIFT_BAND))) diff = 'price_down';
        else diff = 'same';
      }
    } else if (ours != null) {
      diff = 'same';
    }
    return {
      ...item,
      imported: ours,
      diff,
      driftPct,
      isFree: !catalogCharged,
      priceWarning: catalogCharged && weSellFree,
    };
  });
}

/**
 * 上游消失检测：库内已有映射的 realModel 不在目录里 = 候选消失行
 * （调用方再按渠道绑定过滤——只对绑定到该源渠道的映射判消失，跨源同名不误伤）。
 */
export function goneFromCatalog(
  existing: ReadonlyArray<{ mappingId: number; externalName: string; realModel: string }>,
  catalogRealModels: ReadonlySet<string>,
): Array<{ mappingId: number; externalName: string; realModel: string }> {
  return existing.filter((e) => !catalogRealModels.has(e.realModel));
}
