'use client';

// 定价编辑器域组件（受控 value/onChange，不绑 RHF）：官方价/成本价双轴完全同构——
// 计价方式（unitLocked 只读 chip / 可切换卡片，切换联动档位重建与 selector 重置）、
// token 四价与单位单价分派（PriceAxesFields）、分时段（schedule）与参数差价（variant）
// 单值互斥编辑（ScheduleWindowsEditor / VariantTiersEditor）。策略行模型草稿
// （PricingValue.strategy）随受控值回传（跨折叠/重挂载存活）；提交组装由消费方在
// 提交时点经 buildPricingBillingConfig 收口（windows/tiers 未填齐的错误分流到 setError/toast）。
// 成本轴（axes='cost'）空输入以「继承 {官方平价}」占位回显实际生效值；
// 免费为受控标记（free/onFreeChange——勾选不清价格，业务判定走标记）。

import { useLocale, useTranslations } from 'next-intl';

import { Checkbox } from '@tillgate/ui';

import { formatMoney, unitWord } from '@/lib/formatters';
import type { PricingUnit } from './model-pricing';
import {
  emptyStrategyDraft,
  isUnitMode,
  pricingUnitOptions,
  switchStrategyDraftUnit,
  type PriceAxes,
  type PricingFieldErrors,
  type PricingStrategyDraft,
  type PricingValue,
} from './billing-config-payload';
import { PriceAxesFields } from './pricing-price-axes';
import { PricingUnitPicker } from './pricing-unit-picker';
import { ScheduleWindowsEditor } from './schedule-windows-editor';
import { VariantTiersEditor } from './variant-tiers-editor';

export type { PricingFieldErrors, PricingValue } from './billing-config-payload';

/** 计价提示行：token/单位计价说明（选完计价方式后显示）+ 成本轴继承语义摘要 */
function pricingHints(props: {
  chosen: boolean;
  unitMode: boolean;
  axes: 'official' | 'cost';
  pricingUnit: string;
  locale: 'en' | 'zh';
  t: ReturnType<typeof useTranslations<'models'>>;
}) {
  const { chosen, unitMode, axes, pricingUnit, locale, t } = props;
  if (!chosen) return null;
  return (
    <>
      <p className="text-xs text-muted-foreground">
        {unitMode ? t('unitModeHint', { unit: unitWord(pricingUnit, locale) }) : t('tokenModeHint')}
      </p>
      {axes === 'cost' ? (
        <p className="text-xs text-muted-foreground">{t('costStrategyHint')}</p>
      ) : null}
    </>
  );
}

/** 成本轴继承占位工厂：空输入占位 = 「继承 {官方平价对应轴}」；官方值缺失回落 undefined */
function inheritPlaceholderOf(props: {
  axes: 'official' | 'cost';
  referenceValue?: PricingValue;
  t: ReturnType<typeof useTranslations<'models'>>;
}): ((axis: keyof PriceAxes) => string | undefined) | undefined {
  const { axes, referenceValue, t } = props;
  if (axes !== 'cost' || referenceValue == null) return undefined;
  return (axis) => {
    const raw = referenceValue[axis];
    if (raw.trim() === '') return; // 无官方值可显——回落各轴默认占位
    return t('inheritPricePlaceholder', { value: formatMoney(raw) });
  };
}

/** 计费单位选项形状（pricingUnitOptions 元素——icon 为 lucide 组件） */
type UnitOption = ReturnType<typeof pricingUnitOptions>[number] | undefined;

/** 计价方式选择节点：锁定态只读 chip（单位创建时确定）/ 编辑态卡片直选（互斥二选一） */
function unitSelectorNode(props: {
  unitLocked: boolean;
  pricingUnit: string;
  unitOption: UnitOption;
  invalid: boolean;
  error: { message?: string } | undefined;
  onUnitChange: (unit: PricingUnit) => void;
  t: ReturnType<typeof useTranslations<'models'>>;
}) {
  const { unitLocked, pricingUnit, unitOption, t } = props;
  if (unitLocked) {
    return (
      <p className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 py-1.5 text-sm font-medium">
          {unitOption ? <unitOption.icon className="size-4 text-muted-foreground" /> : null}
          {unitOption?.name ?? pricingUnit}
        </span>
        <span className="text-xs text-muted-foreground">{t('unitLockedHint')}</span>
      </p>
    );
  }
  return (
    <PricingUnitPicker
      value={pricingUnit}
      invalid={props.invalid}
      error={props.error}
      onChange={props.onUnitChange}
      t={t}
    />
  );
}

/** 免费渠道开关节点（函数调用而非组件——no-multi-component 门禁与 JSX 小写标签语义） */
function costFreeToggleNode(props: {
  shown: boolean;
  costFree: boolean;
  onFreeChange?: (on: boolean) => void;
  t: ReturnType<typeof useTranslations<'models'>>;
}) {
  const { shown, costFree, t } = props;
  if (!shown) return null;
  return (
    <div className="space-y-1">
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={costFree}
          onCheckedChange={(v) => props.onFreeChange?.(v === true)}
        />
        {t('costFreeLabel')}
      </label>
      <p className="text-xs text-muted-foreground">{t('costFreeHint')}</p>
    </div>
  );
}

export function PricingEditor({
  value,
  onChange,
  axes,
  unitLocked,
  allowEmpty,
  referenceValue,
  disabled,
  fieldErrors,
  rootError,
  free,
  onFreeChange,
}: {
  value: PricingValue;
  onChange: (next: PricingValue) => void;
  /** 价格轴语义：official=模型官方卖价（必填，免费由 disabled 表达）/ cost=渠道成本覆盖（空 = 继承） */
  axes: 'official' | 'cost';
  /** true = 计价方式只读展示（创建时确定，编辑不可改）；false = 内嵌卡片选择器可切换 */
  unitLocked: boolean;
  /** cost 轴必传：官方平价参照（继承占位回显）；official 轴忽略 */
  referenceValue?: PricingValue;
  /** cost 轴 true（空 = 继承）；official 轴固定 false（必填） */
  allowEmpty: boolean;
  /** 灰化价格输入（免费模型；策略编辑不受限——提交时免费五价归零仍生效） */
  disabled?: boolean;
  /** 字段级错误（RHF 嵌套 errors 透传；绑定行等非 RHF 消费方不传） */
  fieldErrors?: PricingFieldErrors;
  /** 提交校验失败信息（分时段/差价未填齐），编辑器内联渲染 */
  rootError?: { message?: string };
  /** 成本免费标记（仅 cost 轴消费）：true = 价格输入灰化但保持原值、策略编辑隐藏 */
  free?: boolean;
  /** 免费标记切换（仅 cost 轴消费；价格值不由编辑器改动） */
  onFreeChange?: (on: boolean) => void;
}) {
  const t = useTranslations('models');
  const tc = useTranslations('common');
  const locale = useLocale() as 'en' | 'zh';
  const { pricingUnit } = value;
  const chosen = pricingUnit !== '';
  const unitMode = isUnitMode(pricingUnit);
  // 策略草稿受控取用：消费方未携带（创建初值）时按计价方式取空草稿
  const draft = value.strategy ?? emptyStrategyDraft(pricingUnit);
  const unitOption = pricingUnitOptions(t).find((o) => o.value === pricingUnit);

  /** 切换计价方式：单一 onChange 收口（差价档位按新单位重建 + selector 重置默认，随值回传） */
  function onUnitChange(unit: PricingUnit) {
    onChange({ ...value, pricingUnit: unit, strategy: switchStrategyDraftUnit(draft, unit) });
  }

  function patchStrategy(next: Partial<PricingStrategyDraft>) {
    onChange({ ...value, strategy: { ...draft, ...next } });
  }

  // 免费开关为受控 prop（用户裁决：勾选免费不清价格——价格保持继承默认，
  // 业务判定走标记；回显来自绑定行 costIsFree 而非价格推导）
  const costFree = axes === 'cost' && free === true;

  // 继承占位工厂在模块级 inheritPlaceholderOf（官方轴 undefined——各轴默认文案）
  const pricePlaceholderOf = inheritPlaceholderOf({ axes, referenceValue, t });

  return (
    <div className="space-y-3">
      {/* 计价方式：锁定态只读 chip（模块级 unitSelectorNode）/ 编辑态卡片直选 */}
      {unitSelectorNode({
        unitLocked,
        pricingUnit,
        unitOption,
        invalid: fieldErrors?.pricingUnit != null,
        error: fieldErrors?.pricingUnit,
        onUnitChange,
        t,
      })}
      {chosen ? (
        <PriceAxesFields
          axes={axes}
          unitMode={unitMode}
          pricingUnit={pricingUnit}
          locale={locale}
          disabled={disabled || costFree}
          allowEmpty={allowEmpty}
          value={value}
          referenceValue={referenceValue}
          fieldErrors={fieldErrors}
          onChange={(patch: Partial<PriceAxes>) => onChange({ ...value, ...patch })}
          t={t}
        />
      ) : null}
      {/* 免费渠道开关（仅成本轴，渲染在模块级 costFreeToggleNode——降主组件复杂度） */}
      {costFreeToggleNode({
        shown: chosen && axes === 'cost',
        costFree,
        onFreeChange,
        t,
      })}
      {/* 分时段定价（schedule）：全部计价方式可用；启用即与参数差价互斥（strategy 单值） */}
      {chosen && !costFree ? (
        <ScheduleWindowsEditor
          scheduleOn={draft.scheduleOn}
          windows={draft.windows}
          unitMode={unitMode}
          pricingUnit={pricingUnit}
          locale={locale}
          rootError={rootError}
          onScheduleToggle={(on) => patchStrategy({ scheduleOn: on })}
          onChange={(update) => patchStrategy({ windows: update(draft.windows) })}
          pricePlaceholderOf={pricePlaceholderOf}
          t={t}
          tc={tc}
        />
      ) : null}
      {/* 参数差价（variant）：仅单位计价；分时段启用时互斥隐藏 */}
      {unitMode && !draft.scheduleOn && !costFree ? (
        <VariantTiersEditor
          pricingUnit={pricingUnit}
          selector={draft.selector}
          tiers={draft.tiers}
          locale={locale}
          rootError={rootError}
          onSelectorChange={(selector) => patchStrategy({ selector })}
          onChange={(update) => patchStrategy({ tiers: update(draft.tiers) })}
          pricePlaceholderOf={pricePlaceholderOf}
          t={t}
          tc={tc}
        />
      ) : null}
      {/* 提示行（函数调用而非组件——no-multi-component 门禁与 JSX 小写标签语义） */}
      {pricingHints({ chosen, unitMode, axes, pricingUnit, locale, t })}
    </div>
  );
}
