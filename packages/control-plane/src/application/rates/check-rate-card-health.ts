/**
 * 费率卡健康自检（数据模型 §3.9）：每卡恰一全局兜底行。
 */
import type { Db } from '@tillgate/db';
import type { RateCardStore } from '../../ports/rate-card-store';
import { controlPlaneErrors } from '../../errors';

export interface RateCardHealthDeps {
  readonly db: Db;
  readonly stores: { readonly rateCard: RateCardStore };
}

export interface RateCardHealth {
  readonly hasGlobalCoefficient: boolean;
  readonly coefficient: string | null;
}

export async function checkRateCardHealth(
  deps: RateCardHealthDeps,
  rateCardId: number,
): Promise<RateCardHealth> {
  const card = await deps.stores.rateCard.findById(deps.db, rateCardId);
  if (!card) {
    throw controlPlaneErrors.business('rate_card_not_found', { rateCardId });
  }
  const coefficient = await deps.stores.rateCard.findGlobalCoefficient(deps.db, rateCardId);
  return { hasGlobalCoefficient: coefficient != null, coefficient };
}
