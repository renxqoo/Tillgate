'use client';

// 渠道表单：字段面 + 创建校验 schema + 表单体（创建/编辑弹窗共用）

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
import { numericText } from '@/lib/forms';
import type { ProviderOption } from '@tillgate/api-client';

// 校验消息走目录：schema 在组件内用 t 构造
export function buildCreateSchema(
  t: ReturnType<typeof useTranslations<'channels'>>,
  tc: ReturnType<typeof useTranslations<'common'>>,
) {
  return z.object({
    providerId: z.coerce.number().min(1, t('providerRequired')),
    name: z.string().min(1, t('nameRequired')),
    apiKey: z.string().min(1, t('apiKeyRequired')),
    baseUrlOverride: z.string().optional(),
    models: z.string().optional(),
    weight: numericText({ message: tc('invalidInteger') })
      .refine((v) => Number.isInteger(v), tc('invalidInteger'))
      .refine((v) => v >= 1 && v <= 1000, t('weightRange')),
    priority: numericText({ message: tc('invalidInteger') })
      .refine((v) => Number.isInteger(v), tc('invalidInteger'))
      .refine((v) => v >= 0, t('priorityNonNegative')),
  });
}

/** ChannelForm 消费的表单字段面（创建/编辑共用；providerId/status 为 coerce 输入侧 unknown） */
export interface ChannelFormValues {
  providerId: unknown;
  name: string;
  apiKey: string;
  baseUrlOverride?: string;
  models?: string;
  weight: string;
  priority: string;
  /** 以下仅编辑态 */
  status?: unknown;
  rpmLimit?: string;
  tpmLimit?: string;
  upstreamThreshold?: string;
}

// eslint-disable-next-line max-lines-per-function -- 渠道表单全字段平铺（凭据/限流/重试参数逐项 UI 声明），拆分收益为负（存量棘轮）
export function ChannelForm({
  form,
  onSubmit,
  formId,
  providers,
  isEdit = false,
}: {
  form: UseFormReturn<ChannelFormValues>;
  onSubmit: (values: ChannelFormValues) => void;
  formId: string;
  providers: ReadonlyArray<ProviderOption>;
  isEdit?: boolean;
}) {
  const t = useTranslations('channels');
  const tc = useTranslations('common');
  return (
    <form id={formId} onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
      <FieldGroup>
        {!isEdit && (
          <Controller
            control={form.control}
            name="providerId"
            render={({
              field,
              fieldState,
            }: {
              field: { value: unknown; onChange: (v: number) => void };
              fieldState: { invalid?: boolean; error?: { message?: string } };
            }) => (
              <FormItem data-invalid={fieldState.invalid}>
                <FieldLabel>{t('provider')}</FieldLabel>
                <Select
                  value={String(field.value ?? 0)}
                  onValueChange={(v) => field.onChange(Number(v))}
                  items={providers.map((p) => ({ value: String(p.id), label: p.name }))}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t('selectProvider')} />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((p) => (
                      <SelectItem key={p.id} value={String(p.id)}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </FormItem>
            )}
          />
        )}
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
              <FieldLabel htmlFor="ch-name">{t('channelName')}</FieldLabel>
              <Input id="ch-name" {...field} />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </FormItem>
          )}
        />
        <Controller
          control={form.control}
          name="apiKey"
          render={({
            field,
            fieldState,
          }: {
            field: { value: string };
            fieldState: { invalid?: boolean; error?: { message?: string } };
          }) => (
            <FormItem data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="ch-key">{isEdit ? t('apiKeyKeep') : t('apiKey')}</FieldLabel>
              <Input id="ch-key" type="password" {...field} placeholder={isEdit ? '••••••' : ''} />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </FormItem>
          )}
        />
        <Controller
          control={form.control}
          name="baseUrlOverride"
          render={({ field }: { field: { value?: string } }) => (
            <FormItem>
              <FieldLabel htmlFor="ch-url">{t('baseUrlOverride')}</FieldLabel>
              <Input id="ch-url" placeholder={t('overridePlaceholder')} {...field} />
            </FormItem>
          )}
        />
        <Controller
          control={form.control}
          name="models"
          render={({ field }: { field: { value?: string } }) => (
            <FormItem>
              <FieldLabel htmlFor="ch-models">{t('modelsLabel')}</FieldLabel>
              <Input id="ch-models" placeholder={t('modelsPlaceholder')} {...field} />
            </FormItem>
          )}
        />
        <div className="grid grid-cols-2 gap-3">
          <NumberField
            control={form.control}
            name="weight"
            label={t('weight')}
            id="ch-weight"
            step="1"
            min={1}
          />
          <NumberField
            control={form.control}
            name="priority"
            label={t('priority')}
            id="ch-priority"
            step="1"
            min={0}
          />
        </div>
        {isEdit && (
          <>
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
                      { value: '0', label: tc('enabled') },
                      { value: '1', label: t('statusDegraded') },
                      { value: '2', label: tc('disabled') },
                      { value: '4', label: t('statusDead') },
                    ]}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">{tc('enabled')}</SelectItem>
                      <SelectItem value="1">{t('statusDegraded')}</SelectItem>
                      <SelectItem value="2">{tc('disabled')}</SelectItem>
                      <SelectItem value="4">{t('statusDead')}</SelectItem>
                    </SelectContent>
                  </Select>
                </FormItem>
              )}
            />
            <div className="grid grid-cols-2 gap-3">
              <Controller
                control={form.control}
                name="rpmLimit"
                render={({ field }: { field: { value?: string } }) => (
                  <FormItem>
                    <FieldLabel htmlFor="ch-rpm">{t('rpmLimit')}</FieldLabel>
                    <Input id="ch-rpm" type="number" {...field} placeholder={tc('default')} />
                  </FormItem>
                )}
              />
              <Controller
                control={form.control}
                name="tpmLimit"
                render={({ field }: { field: { value?: string } }) => (
                  <FormItem>
                    <FieldLabel htmlFor="ch-tpm">{t('tpmLimit')}</FieldLabel>
                    <Input id="ch-tpm" type="number" {...field} placeholder={tc('default')} />
                  </FormItem>
                )}
              />
            </div>
            <Controller
              control={form.control}
              name="upstreamThreshold"
              render={({ field }: { field: { value?: string } }) => (
                <FormItem>
                  <FieldLabel htmlFor="ch-threshold">{t('circuitThreshold')}</FieldLabel>
                  <Input id="ch-threshold" type="number" step="0.01" {...field} placeholder="0" />
                </FormItem>
              )}
            />
          </>
        )}
      </FieldGroup>
    </form>
  );
}
