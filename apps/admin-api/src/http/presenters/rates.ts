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
  readonly updatedAt: Date;
  readonly coefficient: string;
}

export function toRateCardWireRow(row: RateCardRowSource) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
    coefficient: row.coefficient,
  };
}
