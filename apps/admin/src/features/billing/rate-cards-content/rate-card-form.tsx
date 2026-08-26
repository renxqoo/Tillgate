'use client';

// 费率卡共享表单：字段面 + 校验 schema + 表单体（创建/编辑弹窗共用）

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
import { z } from 'zod';

// 校验消息走目录：schema 在组件内用 t 构造
export function buildSchema(t: ReturnType<typeof useTranslations<'rateCards'>>) {
  return z.object({
    name: z.string().min(1),
    coefficient: z
      .string()
      .regex(/^(?:[0-9](?:\.\d{1,3})?)$/, t('coefficientRange'))
      .refine((v) => v !== '0' && !/^0\.0+$/.test(v), t('coefficientPositive')),
    description: z.string().optional(),
  });
}

/** RateCardForm 消费的表单字段面（创建无 status；编辑 coerce 输入侧为 unknown） */
export interface RateCardFormValues {
  name: string;
  coefficient: string;
  description?: string;
  status: unknown;
}

export function RateCardForm({
  form,
  onSubmit,
  formId,
  isEdit = false,
}: {
  form: UseFormReturn<RateCardFormValues>;
  onSubmit: (v: RateCardFormValues) => void;
  formId: string;
  isEdit?: boolean;
}) {
  const t = useTranslations('rateCards');
  const tc = useTranslations('common');
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
              <FieldLabel htmlFor="rc-name">{tc('name')}</FieldLabel>
              <Input id="rc-name" placeholder={t('namePlaceholder')} {...field} />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </FormItem>
          )}
        />
        <NumberField
          control={form.control}
          name="coefficient"
          label={t('coefficientLabel')}
          id="rc-coef"
          step="0.001"
          min={0.001}
        />
        <Controller
          control={form.control}
          name="description"
          render={({ field }: { field: { value?: string } }) => (
            <FormItem>
              <FieldLabel htmlFor="rc-desc">{t('descriptionLabel')}</FieldLabel>
              <Input id="rc-desc" placeholder={tc('optional')} {...field} />
            </FormItem>
          )}
        />
        {isEdit && (
          <Controller
            control={form.control}
            name="status"
            render={({ field }: { field: { value: unknown; onChange: (v: number) => void } }) => (
              <FormItem>
                <FieldLabel>{tc('status')}</FieldLabel>
                <Select
                  value={String(field.value)}
                  onValueChange={(v) => field.onChange(Number(v))}
                  items={[
                    { value: '0', label: tc('enabled') },
                    { value: '1', label: tc('disabled') },
                  ]}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">{tc('enabled')}</SelectItem>
                    <SelectItem value="1">{tc('disabled')}</SelectItem>
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
