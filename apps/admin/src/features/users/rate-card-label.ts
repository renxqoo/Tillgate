/**
 * 费率卡展示标签（用户列表行/详情卡/绑定下拉同口径）：`名称 (x系数)`。
 * 无卡 '—'；options 未命中（卡已删/陈旧引用）退回纯名称——名称来自行投影，恒可信。
 */
import { fmtCoefficient } from '@/lib/formatters';

export interface RateCardOptionLike {
  id: number;
  name: string;
  coefficient: string;
}

export function rateCardLabel(
  card: { rateCardId: number | null; rateCardName: string | null },
  options: ReadonlyArray<RateCardOptionLike>,
): string {
  if (card.rateCardId == null || card.rateCardName == null) return '—';
  const hit = options.find((o) => o.id === card.rateCardId);
  if (hit == null) return card.rateCardName;
  return `${card.rateCardName} (x${fmtCoefficient(hit.coefficient)})`;
}
