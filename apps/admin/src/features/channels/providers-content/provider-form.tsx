'use client';

// 渠道商共享表单：字段面 + 校验 schema + 表单体（创建/编辑弹窗共用）

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
import { useTranslations } from 'next-intl';
import { Controller, type UseFormReturn } from 'react-hook-form';
import { z } from 'zod';

export interface ProviderFormValues {
  name: string;
  baseUrl: string;
  protocol: string;
  vendor: string;
  status: number;
}

// 校验消息走目录：schema 在组件内用 t 构造
export function buildProviderSchema(t: ReturnType<typeof useTranslations<'providers'>>) {
  return z.object({
    name: z.string().min(1, t('nameRequired')),
    baseUrl: z.string().url(t('invalidUrl')),
    protocol: z.string().min(1),
    vendor: z.string(),
    status: z.coerce.number().int(),
  });
}

export function ProviderForm({
  form,
  onSubmit,
  formId,
  protocols,
  vendors,
}: {
  form: UseFormReturn<ProviderFormValues>;
  onSubmit: (v: ProviderFormValues) => void;
  formId: string;
  readonly protocols: ReadonlyArray<string>;
  readonly vendors: ReadonlyArray<string>;
}) {
  const t = useTranslations('providers');
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
              <FieldLabel htmlFor="p-name">{tc('name')}</FieldLabel>
              <Input id="p-name" {...field} />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </FormItem>
          )}
        />
        <Controller
          control={form.control}
          name="baseUrl"
          render={({
            field,
            fieldState,
          }: {
            field: { value: string };
            fieldState: { invalid?: boolean; error?: { message?: string } };
          }) => (
            <FormItem data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="p-url">Base URL</FieldLabel>
              <Input id="p-url" placeholder="https://api.openai.com/v1" {...field} />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </FormItem>
          )}
        />
        <Controller
          control={form.control}
          name="protocol"
          render={({ field }: { field: { value: string; onChange: (v: string) => void } }) => (
            <FormItem>
              <FieldLabel>{t('protocol')}</FieldLabel>
              <Select value={field.value} onValueChange={(v) => field.onChange(v ?? '')}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {protocols.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormItem>
          )}
        />
        <Controller
          control={form.control}
          name="vendor"
          render={({ field }: { field: { value: string; onChange: (v: string) => void } }) => (
            <FormItem>
              <FieldLabel>{t('vendorProfile')}</FieldLabel>
              <Select
                value={field.value || 'none'}
                onValueChange={(v) => field.onChange(!v || v === 'none' ? '' : v)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('noVendor')}</SelectItem>
                  {vendors.map((v) => (
                    <SelectItem key={v} value={v}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormItem>
          )}
        />
        <Controller
          control={form.control}
          name="status"
          render={({ field }: { field: { value: number; onChange: (v: number) => void } }) => (
            <FormItem>
              <FieldLabel>{tc('status')}</FieldLabel>
              <Select value={String(field.value)} onValueChange={(v) => field.onChange(Number(v))}>
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
      </FieldGroup>
    </form>
  );
}
