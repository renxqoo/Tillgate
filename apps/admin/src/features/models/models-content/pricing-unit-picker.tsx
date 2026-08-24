'use client';

// 计价方式卡片选择器（受控哑件）：卡片直选决定表单下方出现哪些价格输入；
// 切换联动（清字段错误 + 档位按新单位重建 + selector 重置默认）经 onPicked 回调由 model-form 编排

import { FieldError, FieldLabel, FormItem, cn } from '@tillgate/ui';
import type { useTranslations } from 'next-intl';

import type { PricingUnit } from './model-pricing';
import { pricingUnitOptions } from './billing-config-payload';

export function PricingUnitPicker({
  value,
  invalid,
  error,
  onChange,
  onPicked,
  t,
}: {
  /** 当前计价方式（RHF pricingUnit 字段值） */
  value: string;
  invalid?: boolean;
  error?: { message?: string };
  /** 选中卡片：写回 RHF 字段值 */
  onChange: (unit: PricingUnit) => void;
  /** 选中卡片后的联动（编排器侧：清 pricingUnit 错误 + 档位按新单位重建 + selector 重置默认） */
  onPicked: (unit: PricingUnit) => void;
  t: ReturnType<typeof useTranslations<'models'>>;
}) {
  return (
    <FormItem data-invalid={invalid}>
      <FieldLabel>{t('pricingMethod')}</FieldLabel>
      <div
        role="radiogroup"
        aria-label={t('pricingMethod')}
        className="grid grid-cols-2 gap-2 sm:grid-cols-3"
      >
        {pricingUnitOptions(t).map((o) => {
          const selected = value === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => {
                if (selected) return;
                onChange(o.value);
                onPicked(o.value);
              }}
              className={cn(
                'flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors',
                selected
                  ? 'border-primary bg-primary/5 ring-1 ring-primary'
                  : 'border-input hover:bg-muted/50',
              )}
            >
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <o.icon className="size-4 text-muted-foreground" />
                {o.name}
              </span>
              <span className="text-xs text-muted-foreground">{o.desc}</span>
            </button>
          );
        })}
      </div>
      {invalid && <FieldError errors={[error]} />}
    </FormItem>
  );
}
