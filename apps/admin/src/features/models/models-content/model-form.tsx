'use client';

// 模型共享表单骨架（编排器）：基价分派（token 四价/单位单价）+ 公共字段 + 编辑态高级区；
// 三套定价编辑器（计价卡片/分时段/参数差价）与构造纯函数在同目录分域文件，
// strategy 单值互斥与切换联动在本文件经 props/回调接线。

import {
  Button,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  FieldError,
  FieldGroup,
  FieldLabel,
  FormItem,
  Input,
  Textarea,
} from '@tillgate/ui';
import { NumberField } from '@/components/number-field';
import { useState } from 'react';

import { useLocale, useTranslations } from 'next-intl';
import { Controller, useWatch, type UseFormReturn } from 'react-hook-form';

import { unitWord } from '@/lib/formatters';
import type { PricingUnit } from './model-pricing';
import {
  DEFAULT_SELECTOR,
  buildBillingConfigPayload,
  buildTiers,
  buildWindows,
  type TierRow,
  type WindowRow,
  type WithBillingConfig,
} from './billing-config-payload';
import { PricingUnitPicker } from './pricing-unit-picker';
import { ScheduleWindowsEditor } from './schedule-windows-editor';
import { VariantTiersEditor } from './variant-tiers-editor';

export type { WithBillingConfig } from './billing-config-payload';

/** selector 编辑初值：存量 billingConfig 优先，否则按计价方式取默认，末位兜底 'model' */
function initialSelectorFor(
  cfg: { params?: { selector?: string } } | undefined,
  unit: string,
): string {
  return cfg?.params?.selector ?? DEFAULT_SELECTOR[unit as PricingUnit] ?? 'model';
}

/**
 * ModelForm 消费的表单字段面：创建/编辑两个 zod schema 的公共超集
 * （编辑态扩展字段可选；泛型 T 保留各调用方的完整形状，提交值经 onSubmit 原样透传）。
 */
export interface ModelFormValues {
  externalName: string;
  realModel: string;
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  cacheWritePrice: string;
  pricingUnit: string;
  unitPrice: string;
  contextLength: string;
  isFree?: boolean;
  /* 以下仅编辑态存在（isEdit 高级区）；status 按编辑 schema 定为必选，
     创建 schema 无这些字段——创建调用点以一次边界断言传入 */
  fallbackModels?: string;
  paramRules?: string;
  billingPolicy?: string;
  rpmLimit?: string;
  tpmLimit?: string;
  status: string;
}

// eslint-disable-next-line max-lines-per-function -- 编排器骨架：公共字段/基价分派逐项平铺（10 Controller + 7 NumberField）+ 编辑态高级区按拆分契约留驻本文件，三套定价编辑器与提交组装已拆同目录分域文件
export function ModelForm({
  form,
  onSubmit,
  formId,
  isEdit = false,
  initialBillingConfig,
}: {
  form: UseFormReturn<ModelFormValues>;
  onSubmit: (v: WithBillingConfig<ModelFormValues>) => void;
  formId: string;
  isEdit?: boolean;
  /** 差价/时段编辑器初始值（编辑回显——billingConfig 不走 RHF 字段） */
  initialBillingConfig?: {
    strategy?: string;
    params?: {
      selector?: string;
      prices?: Record<string, string>;
      windows?: Array<Record<string, string>>;
    };
  };
}) {
  const t = useTranslations('models');
  const tc = useTranslations('common');
  const locale = useLocale() as 'en' | 'zh';
  // 计价方式优先：未选择时隐藏全部价格输入；token 显三价+缓存写价；单位模式（图片/视频/语音/按次）显单位单价+可选差价。
  // useWatch（而非 form.watch）确保 Controller 外的订阅重渲染稳定。
  const pricingUnit: string = useWatch({ control: form.control, name: 'pricingUnit' }) ?? '';
  const chosen = pricingUnit !== '';
  const unitMode = chosen && pricingUnit !== 'token';
  // 免费模型：价格输入禁用免填（提交时五价归零），取消勾选即恢复编辑与必填校验
  const isFree = useWatch({ control: form.control, name: 'isFree' }) ?? false;
  // 差价档位编辑器（variant 策略）：直接勾选预设档位（1K/2K/720p…）只填单价，参数值固定不可改；selector=取价参数名（下拉直选）。
  // 切换计价方式时档位按新单位重建（已填价格不跨单位保留），selector 重置为新单位默认值。
  const initialConfig = initialBillingConfig;
  const [selector, setSelector] = useState<string>(() =>
    initialSelectorFor(initialConfig, form.getValues('pricingUnit')),
  );
  const [tiers, setTiers] = useState<TierRow[]>(() =>
    buildTiers(form.getValues('pricingUnit') ?? '', initialConfig),
  );
  // 分时段编辑器（schedule 策略）：与参数差价互斥（billingConfig.strategy 单值）；
  // 时段价覆盖全部计价方式（token 三元组 / 单位单价），未覆盖轴回落基价列。
  const [scheduleOn, setScheduleOn] = useState(initialConfig?.strategy === 'schedule');
  const [windows, setWindows] = useState<WindowRow[]>(() => buildWindows(initialConfig));

  /** 切换计价方式联动：清字段错误 + 差价档位按新单位重建（价格不跨单位保留）+ selector 重置默认 */
  function onPricingUnitPicked(unit: PricingUnit) {
    form.clearErrors('pricingUnit');
    setTiers(buildTiers(unit));
    setSelector(DEFAULT_SELECTOR[unit] ?? 'model');
  }

  /** 开关分时段：strategy 单值互斥的编排侧写回 + 清 root 提交校验错误 */
  function onScheduleToggle(on: boolean) {
    setScheduleOn(on);
    form.clearErrors('root');
  }

  /** 勾选预设档位：清 root 提交校验错误（重新勾选即重置失败提示） */
  function onTierToggle() {
    form.clearErrors('root');
  }

  /** RHF 校验通过后的提交编排：billingConfig 组装逐字在 buildBillingConfigPayload，错误分流在此落地 setError（文案走目录） */
  function onSubmitValid(values: ModelFormValues) {
    const built = buildBillingConfigPayload({
      scheduleOn,
      windows,
      tiers,
      selector,
      pricingUnit,
      unitMode,
    });
    if (built.error === 'windows') {
      form.setError('root', { type: 'manual', message: t('windowsFillError') });
      return;
    }
    if (built.error === 'tiers') {
      form.setError('root', { type: 'manual', message: t('tiersFillError') });
      return;
    }
    onSubmit({
      ...values,
      ...(built.billingConfig ? { billingConfig: built.billingConfig } : {}),
    });
  }

  return (
    <form
      id={formId}
      onSubmit={form.handleSubmit(onSubmitValid)}
      className="min-h-0 flex-1 space-y-4 overflow-y-auto"
    >
      <FieldGroup>
        <div className="grid grid-cols-2 gap-3">
          <Controller
            control={form.control}
            name="externalName"
            render={({
              field,
              fieldState,
            }: {
              field: { value: string };
              fieldState: { invalid?: boolean; error?: { message?: string } };
            }) => (
              <FormItem data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="m-ext">{t('externalName')}</FieldLabel>
                <Input id="m-ext" placeholder={t('externalNamePlaceholder')} {...field} />
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </FormItem>
            )}
          />
          <Controller
            control={form.control}
            name="realModel"
            render={({
              field,
              fieldState,
            }: {
              field: { value: string };
              fieldState: { invalid?: boolean; error?: { message?: string } };
            }) => (
              <FormItem data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="m-real">{t('realModel')}</FieldLabel>
                <Input id="m-real" placeholder={t('realModelPlaceholder')} {...field} />
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </FormItem>
            )}
          />
        </div>
        {/* 计价方式：卡片直选（决定下方出现哪些价格输入）；切换时差价档位按新单位重建、selector 重置为新单位默认值 */}
        <Controller
          control={form.control}
          name="pricingUnit"
          render={({ field, fieldState }) => (
            <PricingUnitPicker
              value={field.value}
              invalid={fieldState.invalid}
              error={fieldState.error}
              onChange={field.onChange}
              onPicked={onPricingUnitPicked}
              t={t}
            />
          )}
        />
        {pricingUnit === 'token' ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <NumberField
              control={form.control}
              name="inputPrice"
              label={t('inputPrice')}
              id="m-in"
              step="0.0001"
              disabled={isFree}
            />
            <NumberField
              control={form.control}
              name="outputPrice"
              label={t('outputPrice')}
              id="m-out"
              step="0.0001"
              disabled={isFree}
            />
            <NumberField
              control={form.control}
              name="cacheInputPrice"
              label={t('cachePrice')}
              id="m-cache"
              step="0.0001"
              disabled={isFree}
            />
            <NumberField
              control={form.control}
              name="cacheWritePrice"
              label={t('cacheWritePrice')}
              id="m-cache-w"
              step="0.0001"
              disabled={isFree}
            />
          </div>
        ) : null}
        {unitMode ? (
          <NumberField
            control={form.control}
            name="unitPrice"
            label={t('unitPriceLabel', { unit: unitWord(pricingUnit, locale) })}
            id="m-unit-price"
            step="0.0001"
            disabled={isFree}
          />
        ) : null}
        {/* 分时段定价（schedule）：全部计价方式可用；启用时与参数差价互斥（strategy 单值） */}
        {chosen ? (
          <ScheduleWindowsEditor
            scheduleOn={scheduleOn}
            windows={windows}
            unitMode={unitMode}
            pricingUnit={pricingUnit}
            locale={locale}
            rootError={form.formState.errors.root}
            onScheduleToggle={onScheduleToggle}
            onChange={setWindows}
            t={t}
            tc={tc}
          />
        ) : null}
        {/* 参数差价（variant）：仅单位计价；分时段启用时互斥隐藏 */}
        {unitMode && !scheduleOn ? (
          <VariantTiersEditor
            pricingUnit={pricingUnit}
            selector={selector}
            tiers={tiers}
            locale={locale}
            rootError={form.formState.errors.root}
            onSelectorChange={setSelector}
            onChange={setTiers}
            onTierToggle={onTierToggle}
            t={t}
            tc={tc}
          />
        ) : null}
        <NumberField
          control={form.control}
          name="contextLength"
          label={t('contextLabel')}
          id="m-ctx"
          step="1"
        />
        {chosen ? (
          <p className="text-xs text-muted-foreground">
            {unitMode
              ? t('unitModeHint', { unit: unitWord(pricingUnit, locale) })
              : t('tokenModeHint')}
          </p>
        ) : null}
        <Controller
          control={form.control}
          name="isFree"
          render={({ field }: { field: { value?: boolean; onChange: (v: boolean) => void } }) => (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={field.value ?? false}
                onCheckedChange={(v) => field.onChange(v === true)}
              />
              {t('isFreeLabel')}
            </label>
          )}
        />
        {isFree ? <p className="text-xs text-muted-foreground">{t('freeModeHint')}</p> : null}
        {isEdit && (
          <Collapsible className="rounded-md border p-3">
            <CollapsibleTrigger
              render={
                <Button type="button" variant="ghost" size="sm" className="text-muted-foreground">
                  {t('advanced')}
                </Button>
              }
            />
            <CollapsibleContent className="space-y-4 pt-3">
              <Controller
                control={form.control}
                name="fallbackModels"
                render={({ field }: { field: { value?: string } }) => (
                  <FormItem>
                    <FieldLabel htmlFor="m-fb">{t('fallbackLabel')}</FieldLabel>
                    <Input id="m-fb" {...field} />
                  </FormItem>
                )}
              />
              <Controller
                control={form.control}
                name="paramRules"
                render={({ field }: { field: { value?: string } }) => (
                  <FormItem>
                    <FieldLabel htmlFor="m-rules">{t('paramRulesLabel')}</FieldLabel>
                    <Textarea id="m-rules" rows={3} className="font-mono text-xs" {...field} />
                  </FormItem>
                )}
              />
              <Controller
                control={form.control}
                name="billingPolicy"
                render={({ field }: { field: { value?: string } }) => (
                  <FormItem>
                    <FieldLabel htmlFor="m-billing-policy">{t('billingPolicyLabel')}</FieldLabel>
                    <Textarea
                      id="m-billing-policy"
                      rows={8}
                      className="font-mono text-xs"
                      placeholder={
                        '{"version":1,"billingMode":"unified_input_tokens","maxInputTokens":128000,"modalities":{"image":{"maxItems":20,"maxInlineBytes":20971520}}}'
                      }
                      {...field}
                    />
                  </FormItem>
                )}
              />
              <div className="grid grid-cols-3 gap-3">
                <Controller
                  control={form.control}
                  name="rpmLimit"
                  render={({ field }: { field: { value?: string } }) => (
                    <FormItem>
                      <FieldLabel htmlFor="m-rpm">{t('rpm')}</FieldLabel>
                      <Input id="m-rpm" type="number" {...field} />
                    </FormItem>
                  )}
                />
                <Controller
                  control={form.control}
                  name="tpmLimit"
                  render={({ field }: { field: { value?: string } }) => (
                    <FormItem>
                      <FieldLabel htmlFor="m-tpm">{t('tpm')}</FieldLabel>
                      <Input id="m-tpm" type="number" {...field} />
                    </FormItem>
                  )}
                />
                <NumberField
                  control={form.control}
                  name="status"
                  label={tc('status')}
                  id="m-status"
                  step="1"
                  min={0}
                />
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </FieldGroup>
    </form>
  );
}
