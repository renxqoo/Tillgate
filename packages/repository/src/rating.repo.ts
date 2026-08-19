/**
 * 费率卡系数仓储：整卡快照单查询装载。
 * 热路径消费方（网关 resolve）应在其上加缓存；解析优先级在 domain/rating/coefficient。
 */
import { eq } from 'drizzle-orm';
import { rateCardCoefficients, rateCards } from '@ai-gateway/db';
import type { RepoContext } from './context.js';

/**
 * 系数快照行形状（与 app 侧 domain/rating 的 RateCardCoefficientSnapshot 结构兼容；
 * 本包不 import app 类型——结构化契约，装配点由类型系统校验）。
 */
export interface RateCardCoefficientRow {
  rateCardId: number;
  status: number;
  global: string | null;
  model: Record<number, string>;
  group: Record<string, string>;
}

/** numeric 列尾零规范化（'0.500' → '0.5'；'2.000' → '2'——快照形态稳定，指纹友好） */
function trimNumeric(value: string): string {
  if (!value.includes('.')) return value;
  return value.replace(/0+$/, '').replace(/\.$/, '');
}

/** 费率卡系数仓储（无状态；方法统一接收 RepoContext） */
export class RatingRepository {
  async loadRateCardCoefficients(
    c: RepoContext,
    rateCardId: number,
  ): Promise<RateCardCoefficientRow | null> {
    const card = await c.db.query.rateCards.findFirst({
      where: eq(rateCards.id, rateCardId),
      columns: { id: true, status: true },
    });
    if (!card) return null;
    const rows = await c.db.query.rateCardCoefficients.findMany({
      where: eq(rateCardCoefficients.rateCardId, rateCardId),
      columns: { scope: true, modelMappingId: true, groupKey: true, coefficient: true },
    });
    const snapshot: RateCardCoefficientRow = {
      rateCardId,
      status: card.status,
      global: null,
      model: {},
      group: {},
    };
    for (const row of rows) {
      if (row.scope === 'global' && row.modelMappingId == null) {
        snapshot.global = trimNumeric(row.coefficient);
      } else if (row.scope === 'model' && row.modelMappingId != null) {
        snapshot.model[row.modelMappingId] = trimNumeric(row.coefficient);
      } else if (row.scope === 'group' && row.groupKey != null) {
        snapshot.group[row.groupKey] = trimNumeric(row.coefficient);
      }
    }
    return snapshot;
  }
}
