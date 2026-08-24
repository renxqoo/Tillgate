'use client';

// 参数差价编辑器（variant 策略，受控哑件）：selector 下拉直选 + 档位行勾选/自定义 CRUD；
// 显隐（仅单位计价且未启用分时段）与提交组装由 model-form 编排

import { Button, Checkbox, Input, cn } from '@tillgate/ui';
import type { useTranslations } from 'next-intl';

import { unitWord } from '@/lib/formatters';
import type { PricingUnit } from './model-pricing';
import { SELECTOR_OPTIONS, type TierRow } from './billing-config-payload';

/** 新增自定义档位行的空形状（value=label=手输参数值，恒开） */
const EMPTY_CUSTOM_TIER: TierRow = { label: '', value: '', price: '', on: true, custom: true };

export function VariantTiersEditor({
  pricingUnit,
  selector,
  tiers,
  locale,
  rootError,
  onSelectorChange,
  onChange,
  onTierToggle,
  t,
  tc,
}: {
  pricingUnit: string;
  /** 取价参数名（下拉直选；切换计价方式时由编排器重置为新单位默认值） */
  selector: string;
  tiers: TierRow[];
  locale: 'en' | 'zh';
  /** root 错误位（编排器 form.formState.errors.root）——提交校验失败信息在此渲染 */
  rootError?: { message?: string };
  onSelectorChange: (v: string) => void;
  /** 档位行集合更新（setTiers 直传；函数式更新防行间 stale） */
  onChange: (update: (cur: TierRow[]) => TierRow[]) => void;
  /** 勾选预设档位（编排器：清 root 提交校验错误） */
  onTierToggle: () => void;
  t: ReturnType<typeof useTranslations<'models'>>;
  tc: ReturnType<typeof useTranslations<'common'>>;
}) {
  return (
    <div className="space-y-3 rounded-md border p-4">
      <div>
        <p className="text-sm font-medium">{t('tiersTitle')}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('tiersSubHint')}</p>
      </div>
      <div className="grid max-w-xs gap-1">
        <label className="text-xs text-muted-foreground" htmlFor="m-selector">
          {t('selectorLabel')}
        </label>
        {/* 常用取价参数直选；存量 selector 不在候选内时追加为选项，编辑回显不丢值 */}
        <select
          id="m-selector"
          value={selector}
          onChange={(e) => onSelectorChange(e.target.value)}
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:ring-1 focus-visible:ring-ring"
        >
          {(() => {
            const base = [...(SELECTOR_OPTIONS[pricingUnit as PricingUnit] ?? ['model'])];
            if (selector && !base.includes(selector)) base.push(selector);
            return base.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ));
          })()}
        </select>
      </div>
      {tiers.length > 0 ? (
        <div className="space-y-1.5">
          {tiers.map((tier, i) => {
            const patch = (next: Partial<TierRow>) =>
              onChange((cur) => cur.map((r, j) => (j === i ? { ...r, ...next } : r)));
            const rowOn = tier.custom || tier.on;
            return (
              <div
                key={i}
                className={cn(
                  'flex items-center gap-3 rounded-md border p-2.5',
                  rowOn ? 'border-primary/50 bg-primary/5' : 'border-input',
                )}
              >
                {tier.custom ? (
                  <>
                    <span className="w-16 shrink-0 text-xs text-muted-foreground">
                      {t('customTier')}
                    </span>
                    <Input
                      value={tier.value}
                      onChange={(e) => patch({ value: e.target.value, label: e.target.value })}
                      placeholder={t('paramValuePlaceholder')}
                      className="h-8 max-w-44"
                    />
                  </>
                ) : (
                  <>
                    <label className="flex w-24 shrink-0 items-center gap-2 text-sm font-medium">
                      <Checkbox
                        checked={tier.on}
                        onCheckedChange={(v) => {
                          patch({ on: v === true });
                          onTierToggle();
                        }}
                      />
                      {tier.label}
                    </label>
                    {/* 档位参数值固定不可改：勾选即按该值单独定价，杜绝手输错值 */}
                    <code
                      title={t('tierValueTitle')}
                      className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
                    >
                      {tier.value}
                    </code>
                  </>
                )}
                {rowOn ? (
                  <div className="ml-auto flex shrink-0 items-center gap-2">
                    <Input
                      value={tier.price}
                      onChange={(e) => patch({ price: e.target.value })}
                      placeholder={t('unitPricePlaceholder')}
                      className="h-8 w-36"
                      inputMode="decimal"
                    />
                    <span className="w-14 text-xs text-muted-foreground">
                      ¥/{unitWord(pricingUnit, locale)}
                    </span>
                  </div>
                ) : (
                  <span className="ml-auto text-xs text-muted-foreground">{t('tierFlatHint')}</span>
                )}
                {tier.custom ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="px-2 text-destructive hover:text-destructive"
                    onClick={() => onChange((cur) => cur.filter((_, j) => j !== i))}
                  >
                    {tc('remove')}
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => onChange((cur) => [...cur, { ...EMPTY_CUSTOM_TIER }])}
      >
        {t('addTier')}
      </Button>
      {rootError ? (
        <p className="text-sm text-destructive">{rootError.message ?? t('tiersIncomplete')}</p>
      ) : null}
      <p className="text-xs text-muted-foreground">{t('tiersHint')}</p>
    </div>
  );
}
