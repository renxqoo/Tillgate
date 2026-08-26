'use client';

// 编辑渠道弹窗：编辑 schema（状态/限流/熔断阈值扩展字段）+ ChannelForm 编辑态

import { FormDialog } from '@/components/form-dialog';
import { PencilIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { moneyText, numericText } from '@/lib/forms';
import { useActionResult } from '@/components/action-toast';
import type { AdminChannelRow, ProviderOption } from '@tillgate/api-client';
import { ChannelForm, type ChannelFormValues } from './channel-form';

export function EditChannelDialog({
  channel,
  providers,
  open,
  onOpenChange,
}: {
  channel: AdminChannelRow;
  providers: ReadonlyArray<ProviderOption>;
  /** 受控 open：由行操作菜单项打开（FormDialog 受控模式，无 trigger） */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('channels');
  const tc = useTranslations('common');
  const notify = useActionResult();

  const editSchema = z.object({
    name: z.string().min(1, t('nameRequired')),
    apiKey: z.string().optional(),
    baseUrlOverride: z.string().optional(),
    models: z.string().optional(),
    weight: numericText({ message: tc('invalidInteger') })
      .refine((v) => Number.isInteger(v), tc('invalidInteger'))
      .refine((v) => v >= 1 && v <= 1000, t('weightRange')),
    priority: numericText({ message: tc('invalidInteger') })
      .refine((v) => Number.isInteger(v), tc('invalidInteger'))
      .refine((v) => v >= 0, t('priorityNonNegative')),
    status: z.coerce.number().int(),
    rpmLimit: z.string().optional(),
    tpmLimit: z.string().optional(),
    upstreamThreshold: z
      .union([z.literal(''), moneyText({ message: t('nonNegativeAmount') })])
      .optional(),
  });
  type FormValues = z.input<typeof editSchema>;

  const form = useForm<FormValues>({
    resolver: zodResolver(editSchema) as never,
    defaultValues: {
      name: channel.name,
      apiKey: '',
      baseUrlOverride: channel.baseUrlOverride ?? '',
      models: channel.models ?? '',
      weight: String(channel.weight),
      priority: String(channel.priority),
      status: channel.status,
      rpmLimit: channel.rpmLimit === null ? '' : String(channel.rpmLimit),
      tpmLimit: channel.tpmLimit === null ? '' : String(channel.tpmLimit),
      upstreamThreshold:
        channel.upstreamThreshold === null ? '' : String(channel.upstreamThreshold),
    },
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        <>
          <PencilIcon /> {t('editTitle', { name: channel.name })}
        </>
      }
      titleClassName="flex items-center gap-2"
      description={t('editDescription')}
      submitLabel={tc('save')}
      formId="channel-edit-form"
    >
      {({ run }) => (
        <ChannelForm
          form={form as unknown as UseFormReturn<ChannelFormValues>}
          onSubmit={(values: ChannelFormValues) =>
            run(async () => {
              const { updateChannelAction } = await import('@/server/channels-actions');
              const res = await updateChannelAction(channel.id, {
                name: values.name,
                apiKey: values.apiKey?.trim() || undefined,
                baseUrlOverride: values.baseUrlOverride?.trim() || undefined,
                models: values.models?.trim() || undefined,
                weight: Number(values.weight),
                priority: Number(values.priority),
                status: Number(values.status),
                rpmLimit: values.rpmLimit === '' ? null : Number(values.rpmLimit),
                tpmLimit: values.tpmLimit === '' ? null : Number(values.tpmLimit),
                upstreamThreshold:
                  values.upstreamThreshold === '' ? null : values.upstreamThreshold,
              });
              return notify(res, tc('saveFailed'), tc('saved'));
            })
          }
          formId="channel-edit-form"
          providers={providers}
          isEdit
        />
      )}
    </FormDialog>
  );
}
