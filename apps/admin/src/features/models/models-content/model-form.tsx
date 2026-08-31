'use client';

// 模型共享表单骨架（编排器）：基础信息（两列）+ 定价域（PricingEditor 受控域组件单点接入，
// token 四价一行四列 / 单位单价，分时段与差价全宽在编辑器内部）+ 免费语义 + 编辑态高级区。
// 定价编排（单位→字段集分派、切单位联动、schedule/variant 互斥）在 PricingEditor 与
// billing-config-payload 域文件；本文件只做 RHF 适配：单点 Controller 接线 + 提交时
// billingConfig 收口（buildPricingBillingConfig）与 root 校验错误落地。

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

import { useTranslations } from 'next-intl';
import * as z from 'zod';
import { Controller, useWatch, type UseFormReturn } from 'react-hook-form';

import { PRICING_UNITS, type PricingUnit } from './model-pricing';
import {
  buildPricingBillingConfig,
  emptyStrategyDraft,
  pricingStrategyDraftShape,
  type PricingFieldErrors,
  type PricingValue,
  type WithBillingConfig,
} from './billing-config-payload';
import { PricingEditor } from './pricing-editor';

export type { WithBillingConfig } from './billing-config-payload';

/** pricing 字段 zod 形状（创建/编辑 schema 共用）：计价方式必选 + 价格五价 + 策略草稿（无损行模型） */
export function buildPricingShape(t: ReturnType<typeof useTranslations<'models'>>) {
  return z.object({
    pricingUnit: z
      .string()
      .refine(
        (v): v is PricingUnit => (PRICING_UNITS as readonly string[]).includes(v),
        t('unitRequired'),
      ),
    inputPrice: z.string(),
    outputPrice: z.string(),
    cacheInputPrice: z.string(),
    cacheWritePrice: z.string(),
    unitPrice: z.string(),
    strategy: z.object(pricingStrategyDraftShape).optional(),
  });
}

/**
 * ModelForm 消费的表单字段面：创建/编辑两个 zod schema 的公共超集
 * （编辑态扩展字段可选；泛型 T 保留各调用方的完整形状，提交值经 onSubmit 原样透传）。
 */
export interface ModelFormValues {
  externalName: string;
  realModel: string;
  /** 定价域受控值（PricingEditor 契约）：价格与策略草稿经单点 Controller 接线 */
  pricing: PricingValue;
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

// eslint-disable-next-line max-lines-per-function -- 编排器骨架：基础信息/定价接线/免费语义/编辑态高级区逐项平铺；定价编排在 PricingEditor 域组件，提交组装在 buildPricingBillingConfig
export function ModelForm({
  form,
  onSubmit,
  formId,
  isEdit = false,
}: {
  form: UseFormReturn<ModelFormValues>;
  onSubmit: (v: WithBillingConfig<ModelFormValues>) => void;
  formId: string;
  isEdit?: boolean;
}) {
  const t = useTranslations('models');
  const tc = useTranslations('common');
  // 免费模型：价格输入禁用免填（提交时五价归零），取消勾选即恢复编辑与必填校验
  const isFree = useWatch({ control: form.control, name: 'isFree' }) ?? false;

  /** RHF 校验通过后的提交编排：billingConfig 组装逐字在 buildPricingBillingConfig，错误分流在此落地 setError（文案走目录） */
  function onSubmitValid(values: ModelFormValues) {
    const { pricing } = values;
    const built = buildPricingBillingConfig(
      pricing.strategy ?? emptyStrategyDraft(pricing.pricingUnit),
      pricing.pricingUnit,
    );
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
      <FieldGroup className="gap-4">
        {/* 基础信息（两列） */}
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
        {/* 计价方式与价格（PricingEditor 区块）：编辑态计价方式锁定只读（创建时确定）；分时段/差价全宽 */}
        <section className="space-y-3 rounded-lg border p-4">
          <Controller
            control={form.control}
            name="pricing"
            render={({
              field,
            }: {
              field: { value: PricingValue; onChange: (next: PricingValue) => void };
            }) => (
              <PricingEditor
                value={field.value}
                onChange={(next) => {
                  // 任一定价改动即重置上次提交的 root 校验错误（分时段/差价未填齐提示）
                  form.clearErrors('root');
                  field.onChange(next);
                }}
                axes="official"
                unitLocked={isEdit}
                allowEmpty={false}
                disabled={isFree}
                fieldErrors={form.formState.errors.pricing as PricingFieldErrors | undefined}
                rootError={form.formState.errors.root}
              />
            )}
          />
        </section>
        <NumberField
          control={form.control}
          name="contextLength"
          label={t('contextLabel')}
          id="m-ctx"
          step="1"
        />
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
