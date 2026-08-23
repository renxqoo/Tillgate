/**
 * 费率卡 presenter：RateCardListItem（= RateCardRecord + coefficient）→ AdminRateCardRow。
 */
import { iso } from '../contracts/common';

export interface RateCardRowSource {
  readonly id: number;
  readonly name: string;
  readonly description: string | null;
  readonly status: number;
  readonly createdAt: Date;
  readonly coefficient: string;
}

/** updatedAt 无列来源恒 null（v2 RateCardRecord 无该列——MIGRATION §4 D12 族） */
export function toRateCardWireRow(row: RateCardRowSource) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: iso(row.createdAt)!,
    updatedAt: null,
    coefficient: row.coefficient,
  };
}
