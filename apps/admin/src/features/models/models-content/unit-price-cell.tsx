'use client';

import { Tooltip, TooltipContent, TooltipTrigger } from '@tillgate/ui';
import { useTranslations } from 'next-intl';

import type { AdminModelRow } from '@tillgate/api-client';
import { fmtPrice, unitWord } from '@/lib/formatters';
import { tierLabelFor, tierPricesOf } from './model-pricing';

/**
 * 列表「输出价」列（单位计价）：有差价档位时显示最低价（起），
 * hover 悬浮展示全部档位价（预设档位名 + 参数值）与统一单价回落。
 */
export function UnitPriceCell({ model, locale }: { model: AdminModelRow; locale: 'en' | 'zh' }) {
  const t = useTranslations('models');
  const unit = model.pricingUnit ?? 'request';
  const word = unitWord(unit, locale);
  const tiers = tierPricesOf(model);
  const flat = model.unitPrice ?? '';
  // 展示最低价：档位价与统一单价一起取最小（未命中档位的请求按统一单价计费）
  const candidates = [...tiers.map((x) => x.price), ...(flat !== '' ? [flat] : [])];
  const min = candidates.reduce<string | null>(
    (acc, p) => (acc === null || Number(p) < Number(acc) ? p : acc),
    null,
  );
  if (min === null) return <span>¥0/{word}</span>;
  if (candidates.length < 2) {
    return (
      <span>
        ¥{fmtPrice(min)}/{word}
      </span>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="cursor-help underline decoration-dotted underline-offset-4">
            {t('listFromPrice', { min: fmtPrice(min), unit: word })}
          </span>
        }
      />
      <TooltipContent side="top" className="flex-col items-stretch gap-1 px-3 py-2 text-left">
        <p className="font-medium">{t('tiersTitle')}</p>
        {model.billingConfig?.params?.selector ? (
          <p className="opacity-70">
            {t('listSelectorLine', { selector: model.billingConfig.params.selector })}
          </p>
        ) : null}
        {tiers.map((tr) => {
          const label = tierLabelFor(unit, tr.value);
          return (
            <div key={tr.value} className="flex justify-between gap-6">
              <span>{label === tr.value ? tr.value : `${label} · ${tr.value}`}</span>
              <span>
                ¥{fmtPrice(tr.price)}/{word}
              </span>
            </div>
          );
        })}
        {flat !== '' ? (
          <div className="flex justify-between gap-6 border-t border-background/20 pt-1 opacity-70">
            <span>{t('tierFlatHint')}</span>
            <span>
              ¥{fmtPrice(flat)}/{word}
            </span>
          </div>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}
