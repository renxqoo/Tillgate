'use client';

// 套餐共享表单：字段面 + 校验 schema + 表单体（创建/编辑弹窗共用）

import {
  FieldError,
  FieldGroup,
  FieldLabel,
  FormItem,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@tillgate/ui';
import { NumberField } from '@/components/number-field';
import { useTranslations } from 'next-intl';
import { Controller, type UseFormReturn } from 'react-hook-form';
import * as z from 'zod';

import { moneyText } from '@/lib/forms';

// 校验消息走目录：schema 在组件内用 t 构造
export function buildCreateSchema(t: ReturnType<typeof useTranslations<'plans'>>) {
  return z.object({
    name: z.string().min(1, t('nameRequired')),
    kind: z.enum(['subscription', 'pack']),
    sortOrder: z
      .string()
      .refine(
        (v) => v.trim() === '' || (Number.isFinite(Number(v)) && Number.isInteger(Number(v))),
        t('tierInteger'),
      ),
    price: moneyText({ message: t('invalidPrice'), allowZero: false }),
    periodDays: z.string(),
    quotaAmount: moneyText({ message: t('invalidQuota'), allowZero: false }),
    allowSeats: z.boolean(),
  });
}

/** PlanForm 消费的表单字段面（创建/编辑共用；status 仅编辑态，coerce 输入侧为 unknown） */
export interface PlanFormValues {
  name: string;
  kind: 'subscription' | 'pack';
  sortOrder: string;
  price: string;
  periodDays: string;
  quotaAmount: string;
  allowSeats: boolean;
  status: unknown;
}

// 复用表单字段（创建 / 编辑）
// eslint-disable-next-line max-lines-per-function -- 套餐表单字段平铺（kind 联动显隐逐项 UI 声明），拆分收益为负
export function PlanForm({
  form,
  onSubmit,
  formId,
  isEdit = false,
}: {
  form: UseFormReturn<PlanFormValues>;
  onSubmit: (v: PlanFormValues) => void;
  formId: string;
  isEdit?: boolean;
}) {
  const t = useTranslations('plans');
  const tc = useTranslations('common');
  const kind: 'subscription' | 'pack' = form.watch('kind');
  const isPack = kind === 'pack';

  return (
    <form id={formId} onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
      <FieldGroup>
        <Controller
          control={form.control}
          name="name"
          render={({
            field,
            fieldState,
          }: {
            field: { value: string };
            fieldState: { invalid?: boolean; error?: { message?: string } };
          }) => (
            <FormItem data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="plan-name">{tc('name')}</FieldLabel>
              <Input id="plan-name" placeholder={t('namePlaceholder')} {...field} />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </FormItem>
          )}
        />
        <Controller
          control={form.control}
          name="kind"
          render={({
            field,
          }: {
            field: {
              value: 'subscription' | 'pack';
              onChange: (v: 'subscription' | 'pack') => void;
            };
          }) => (
            <FormItem>
              <FieldLabel>{tc('type')}</FieldLabel>
              <Select
                value={field.value}
                onValueChange={(v) => field.onChange(v ?? 'subscription')}
                disabled={isEdit}
                items={[
                  { value: 'subscription', label: t('subscriptionOption') },
                  { value: 'pack', label: t('packOption') },
                ]}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="subscription">{t('subscriptionOption')}</SelectItem>
                  <SelectItem value="pack">{t('packOption')}</SelectItem>
                </SelectContent>
              </Select>
            </FormItem>
          )}
        />
        <Controller
          control={form.control}
          name="sortOrder"
          render={({
            field,
            fieldState,
          }: {
            field: { value: string };
            fieldState: { invalid?: boolean; error?: { message?: string } };
          }) => (
            <FormItem data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="plan-sort">{t('tierLabel')}</FieldLabel>
              <Input id="plan-sort" type="number" step="1" placeholder={t('blank')} {...field} />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </FormItem>
          )}
        />
        <NumberField
          control={form.control}
          name="price"
          label={t('priceLabel')}
          id="plan-price"
          step="0.01"
          min={0}
        />
        {!isPack && (
          <Controller
            control={form.control}
            name="periodDays"
            render={({ field }: { field: { value: string; onChange: (v: string) => void } }) => (
              <FormItem>
                <FieldLabel>{t('period')}</FieldLabel>
                <Select
                  value={field.value}
                  onValueChange={(v) => v !== null && field.onChange(v)}
                  items={[
                    { value: '30', label: t('monthly') },
                    { value: '365', label: t('yearly') },
                  ]}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="30">{t('monthly')}</SelectItem>
                    <SelectItem value="365">{t('yearly')}</SelectItem>
                  </SelectContent>
                </Select>
              </FormItem>
            )}
          />
        )}
        <NumberField
          control={form.control}
          name="quotaAmount"
          label={t('quotaLabel')}
          id="plan-quota"
          step="0.01"
          min={0}
        />
        {!isPack && (
          <Controller
            control={form.control}
            name="allowSeats"
            render={({ field }: { field: { value: boolean; onChange: (v: boolean) => void } }) => (
              <FormItem>
                <FieldLabel>{t('seatsMode')}</FieldLabel>
                <Select
                  value={field.value ? '1' : '0'}
                  onValueChange={(v) => field.onChange(v === '1')}
                  items={[
                    { value: '0', label: t('personalOption') },
                    { value: '1', label: t('teamOption') },
                  ]}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">{t('personalOption')}</SelectItem>
                    <SelectItem value="1">{t('teamOption')}</SelectItem>
                  </SelectContent>
                </Select>
              </FormItem>
            )}
          />
        )}
        {isEdit && (
          <Controller
            control={form.control}
            name="status"
            render={({ field }: { field: { value: unknown; onChange: (v: number) => void } }) => (
              <FormItem>
                <FieldLabel>{tc('status')}</FieldLabel>
                <Select
                  value={String(field.value ?? 0)}
                  onValueChange={(v) => field.onChange(Number(v))}
                  items={[
                    { value: '0', label: t('listed') },
                    { value: '1', label: t('unlisted') },
                  ]}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">{t('listed')}</SelectItem>
                    <SelectItem value="1">{t('unlisted')}</SelectItem>
                  </SelectContent>
                </Select>
              </FormItem>
            )}
          />
        )}
      </FieldGroup>
    </form>
  );
}
