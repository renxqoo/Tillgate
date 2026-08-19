/**
 * 费率卡系数解析（纯函数半）：
 *   解析优先级 model（按映射）> group（按 pricing_group）> global（卡级兜底）> '1'（无卡/无行）。
 * 快照装载（DB 查询）在 @ai-gateway/repository 的 ratingRepo——口径必须一致，
 * 消费方不得自行查询系数表。
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

/** 纯函数挑选（优先级 model > group > global > '1'）；snapshot=null（无卡）恒 '1' */
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
