// 模型定价域纯函数（多消费方内核）：计价单位词表、差价档位预设、列表档位价展示与价格分支校验。
// 仅被表单消费的编辑器构造件（buildTiers/buildWindows 等）随 model-form，不沉本文件。

import type { AdminModelRow } from '@tillgate/api-client';
import * as z from 'zod';

export const PRICING_UNITS = ['token', 'request', 'image', 'second', 'char'] as const;
export type PricingUnit = (typeof PRICING_UNITS)[number];

/** 差价档位（勾选制）：label=界面档位名，value=固定参数值（与请求参数完全一致，不可改，杜绝手输错值） */
export const TIER_PRESETS: Partial<
  Record<PricingUnit, ReadonlyArray<{ label: string; value: string }>>
> = {
  image: [
    { label: '1K', value: '1024*1024' },
    { label: '2K', value: '2048*2048' },
  ],
  second: [
    { label: '480p', value: '480p' },
    { label: '720p', value: '720p' },
    { label: '1080p', value: '1080p' },
  ],
};

/** 列表用：billingConfig 档位价升序（无 / token 计价 → 空数组） */
export function tierPricesOf(
  model: Pick<AdminModelRow, 'pricingUnit' | 'billingConfig'>,
): Array<{ value: string; price: string }> {
  const prices = model.billingConfig?.params?.prices;
  if (!prices || !model.pricingUnit || model.pricingUnit === 'token') return [];
  return Object.entries(prices)
    .map(([value, price]) => ({ value, price: String(price) }))
    .toSorted((a, b) => Number(a.price) - Number(b.price));
}

/** 档位展示名：预设参数值归位到档位名（1024*1024 → 1K），其余显示原值 */
export function tierLabelFor(unit: string, value: string): string {
  const preset = (TIER_PRESETS[unit as PricingUnit] ?? []).find((p) => p.value === value);
  return preset?.label ?? value;
}

/** 金额格式（与 moneyText 同口径）——分支校验挂到具体字段用 */
const MONEY_PATTERN = /^\d{1,20}(?:\.\d{1,18})?$/;

/**
 * 价格分支校验：只校验当前计价方式下可见的字段。
 * 隐藏字段不参与校验——否则切到单位计价后隐藏的 token 三价仍必填，提交必挂。
 */
export function refinePricing(
  v: {
    pricingUnit: string;
    inputPrice: string;
    outputPrice: string;
    cacheInputPrice: string;
    cacheWritePrice?: string;
    unitPrice?: string;
  },
  ctx: z.RefinementCtx,
  invalidPrice: string,
) {
  const bad = (path: string, message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (v.pricingUnit === 'token') {
    if (!MONEY_PATTERN.test(v.inputPrice ?? '')) bad('inputPrice', invalidPrice);
    if (!MONEY_PATTERN.test(v.outputPrice ?? '')) bad('outputPrice', invalidPrice);
    if (!MONEY_PATTERN.test(v.cacheInputPrice ?? '')) bad('cacheInputPrice', invalidPrice);
    if (
      v.cacheWritePrice != null &&
      v.cacheWritePrice !== '' &&
      !MONEY_PATTERN.test(v.cacheWritePrice)
    ) {
      bad('cacheWritePrice', invalidPrice);
    }
  } else if (v.pricingUnit !== '' && !MONEY_PATTERN.test(v.unitPrice ?? '')) {
    bad('unitPrice', invalidPrice);
  }
}
