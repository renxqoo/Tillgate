import { eq } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { rateCardCoefficients, rateCards } from '@ai-gateway/db/schema';

/**
 * 费率卡系数解析（单一真相，2026-08 分组倍率落地）。
 *
 * 解析优先级：model（按 model_mapping_id）> group（按 model_mappings.pricing_group
 * 匹配 group_key）> global（卡级兜底）> '1'（无卡/无行）。
 *
 * 消费方（口径必须一致，不得自行查询系数表）：
 *   - gateway 鉴权/解析（apps/gateway coefficient-cache + pipeline resolve）
 *   - client-api 公开定价页
 *   - admin-api 系数预览
 *
 * usage_logs.coefficient 是按请求快照，结算不受事后改系数影响；
 * 系数变更对静态 Key 生效延迟 ≤ 快照缓存 TTL（60s），对 App JWT 即时（按卡实时解析）。
 */

export interface RateCardCoefficientSnapshot {
  rateCardId: number;
  /** rate_cards.status：0 启用 / 1 停用（停用语义由消费方决定——网关侧拒绝新请求） */
  status: number;
  global: string | null;
  /** modelMappingId → 系数（scope='model' 行） */
  model: Record<number, string>;
  /** groupKey → 系数（scope='group' 行） */
  group: Record<string, string>;
}

export interface CoefficientLookup {
  modelMappingId: number | null;
  pricingGroup: string | null;
}

/**
 * 一次性载入整卡系数（单查询；热路径消费方应在其上加缓存）。
 * 卡不存在返回 null；行级脏数据（缺 global）不在此抛错——pick 回退 '1' 兜底。
 */
export async function loadRateCardCoefficients(
  db: Db,
  rateCardId: number,
): Promise<RateCardCoefficientSnapshot | null> {
  const card = await db.query.rateCards.findFirst({
    where: eq(rateCards.id, rateCardId),
    columns: { id: true, status: true },
  });
  if (!card) return null;
  const rows = await db.query.rateCardCoefficients.findMany({
    where: eq(rateCardCoefficients.rateCardId, rateCardId),
    columns: { scope: true, modelMappingId: true, groupKey: true, coefficient: true },
  });
  const snapshot: RateCardCoefficientSnapshot = {
    rateCardId,
    status: card.status,
    global: null,
    model: {},
    group: {},
  };
  for (const row of rows) {
    if (row.scope === 'global' && row.modelMappingId == null) {
      snapshot.global = row.coefficient;
    } else if (row.scope === 'model' && row.modelMappingId != null) {
      snapshot.model[row.modelMappingId] = row.coefficient;
    } else if (row.scope === 'group' && row.groupKey != null) {
      snapshot.group[row.groupKey] = row.coefficient;
    }
  }
  return snapshot;
}

/** 纯函数挑选（优先级 model > group > global > '1'）；snapshot=null（无卡）恒 '1'。 */
export function pickCoefficient(
  snapshot: RateCardCoefficientSnapshot | null,
  lookup: CoefficientLookup,
): string {
  if (!snapshot) return '1';
  if (lookup.modelMappingId != null) {
    const byModel = snapshot.model[lookup.modelMappingId];
    if (byModel != null) return byModel;
  }
  if (lookup.pricingGroup != null) {
    const byGroup = snapshot.group[lookup.pricingGroup];
    if (byGroup != null) return byGroup;
  }
  return snapshot.global ?? '1';
}
