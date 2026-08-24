'use client';

// 创建渠道弹窗：创建 schema + ChannelForm（编辑弹窗在 edit-channel-dialog）

import { Button } from '@tillgate/ui';
import { FormDialog } from '@/components/form-dialog';
import { NetworkIcon, PlusCircleIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { useActionResult } from '@/components/action-toast';
import type { ProviderOption } from '@tillgate/api-client';
import { buildCreateSchema, ChannelForm } from './channel-form';

export function CreateChannelDialog({
  providers,
}: {
  readonly providers: ReadonlyArray<ProviderOption>;
}) {
  const t = useTranslations('channels');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const createSchema = buildCreateSchema(t, tc);

  type FormValues = z.input<typeof createSchema>;
  const form = useForm<FormValues>({
    resolver: zodResolver(createSchema) as never,
    defaultValues: {
      providerId: providers[0]?.id ?? 0,
      name: '',
      apiKey: '',
      baseUrlOverride: '',
      models: '',
      weight: '100',
      priority: '0',
    },
  });

  return (
    <FormDialog
      trigger={
        <Button>
          <PlusCircleIcon />
          {t('create')}
        </Button>
      }
      title={
        <>
          <NetworkIcon /> {t('create')}
        </>
      }
      titleClassName="flex items-center gap-2"
      description={t('createDescription')}
      submitLabel={tc('create')}
      formId="channel-form"
    >
      {({ run }) => (
        <ChannelForm
          form={form}
          onSubmit={(values: FormValues) =>
            run(async () => {
              const { createChannelAction } = await import('@/server/channels-actions');
              const res = await createChannelAction({
                ...values,
                providerId: Number(values.providerId),
                weight: Number(values.weight),
                priority: Number(values.priority),
              });
              if (!notify(res, tc('createFailed'), t('channelCreated'))) return false;
              form.reset();
              return true;
            })
          }
          formId="channel-form"
          providers={providers}
        />
      )}
    </FormDialog>
  );
}
