'use client';

// 价格轴字段组（PricingEditor 分派件）：token → 四价一行四列（sm:grid-cols-4，移动端两列）；
// 单位计价 → 单位单价。官方轴必填（字段错误内联渲染，免费语义由 disabled 表达）；
// 成本轴由弹窗预填模型卖价（初值可见可改），用户清空 = 该渠道不记账（按 0 成本）。

import { Fragment, useId } from 'react';
import { FieldError, FieldLabel, FormItem, Input } from '@tillgate/ui';
import type { useTranslations } from 'next-intl';

import { unitWord } from '@/lib/formatters';
import type { PriceAxes, PricingFieldErrors, PricingValue } from './billing-config-payload';

/** token 四价轴渲染顺序（cacheWrite 可空，官方轴文案自带「可空」提示） */
const TOKEN_AXES = ['inputPrice', 'outputPrice', 'cacheInputPrice', 'cacheWritePrice'] as const;

export function PriceAxesFields({
  axes,
  unitMode,
  pricingUnit,
  locale,
  disabled,
  allowEmpty,
  value,
  fieldErrors,
  onChange,
  t,
}: {
  /** 价格轴语义：official=模型官方卖价 / cost=渠道成本覆盖（清空 = 不记账） */
  axes: 'official' | 'cost';
  unitMode: boolean;
  pricingUnit: string;
  locale: 'en' | 'zh';
  disabled?: boolean;
  allowEmpty: boolean;
  value: PricingValue;
  fieldErrors?: PricingFieldErrors;
  onChange: (patch: Partial<PriceAxes>) => void;
  t: ReturnType<typeof useTranslations<'models'>>;
}) {
  const uid = useId();

  /** 各轴 label：成本轴键名与 messages.models cost* 段一致；官方单位轴带单位词 */
  const labels: Record<keyof PriceAxes, string> =
    axes === 'cost'
      ? {
          inputPrice: t('costInputPrice'),
          outputPrice: t('costOutputPrice'),
          cacheInputPrice: t('costCacheInputPrice'),
          cacheWritePrice: t('costCacheWritePrice'),
          unitPrice: t('costUnitPrice'),
        }
      : {
          inputPrice: t('inputPrice'),
          outputPrice: t('outputPrice'),
          cacheInputPrice: t('cachePrice'),
          cacheWritePrice: t('cacheWritePrice'),
          unitPrice: t('unitPriceLabel', { unit: unitWord(pricingUnit, locale) }),
        };

  /** 成本轴清空占位（官方轴无占位——必填语义）：清空 = 不记账，按 0 成本 */
  const emptyPlaceholder = allowEmpty ? t('costEmptyPlaceholder') : undefined;

  function field(axis: keyof PriceAxes) {
    const id = `${uid}-${axis}`;
    return (
      <FormItem data-invalid={fieldErrors?.[axis] != null}>
        <FieldLabel htmlFor={id}>{labels[axis]}</FieldLabel>
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          step="0.0001"
          min={0}
          placeholder={emptyPlaceholder}
          value={value[axis]}
          disabled={disabled}
          onChange={(e) => onChange({ [axis]: e.target.value })}
        />
        {fieldErrors?.[axis] != null && <FieldError errors={[fieldErrors[axis]]} />}
      </FormItem>
    );
  }

  if (unitMode) {
    return field('unitPrice');
  }
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {TOKEN_AXES.map((axis) => (
        <Fragment key={axis}>{field(axis)}</Fragment>
      ))}
    </div>
  );
}
