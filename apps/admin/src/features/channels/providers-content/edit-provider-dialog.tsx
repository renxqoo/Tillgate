'use client';

// 编辑渠道商弹窗（受控 open，由渠道商表格行操作打开）

import type * as React from 'react';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@tillgate/ui';
import { useState, useTransition } from 'react';
import { Loader2Icon, PencilIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { AdminProviderRow } from '@tillgate/api-client';
import { useActionResult } from '@/components/action-toast';
import { buildProviderSchema, ProviderForm, type ProviderFormValues } from './provider-form';

export function EditProviderDialog({
  provider,
  protocols,
  vendors,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  provider: AdminProviderRow;
  readonly protocols: ReadonlyArray<string>;
  readonly vendors: ReadonlyArray<string>;
  trigger?: React.ReactElement | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useTranslations('providers');
  const tc = useTranslations('common');
  const tUi = useTranslations('ui');
  const notify = useActionResult();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [pending, startTransition] = useTransition();
  const schema = buildProviderSchema(t);
  const form = useForm<ProviderFormValues>({
    resolver: zodResolver(schema) as never,
    defaultValues: {
      name: provider.name,
      baseUrl: provider.baseUrl,
      protocol: provider.protocol,
      vendor: provider.vendor ?? '',
      status: provider.status,
    },
  });

  function onSubmit(values: ProviderFormValues) {
    startTransition(async () => {
      const { updateProviderAction } = await import('@/server/providers-actions');
      const res = await updateProviderAction(provider.id, values);
      if (!notify(res, tc('saveFailed'), tc('saved'))) return;
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger !== null ? (
        <DialogTrigger
          render={
            trigger ?? (
              <Button size="sm" variant="ghost" title={tc('edit')}>
                <PencilIcon />
              </Button>
            )
          }
        />
      ) : null}
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PencilIcon /> {t('editTitle', { name: provider.name })}
          </DialogTitle>
        </DialogHeader>
        <ProviderForm
          form={form}
          onSubmit={onSubmit}
          formId="provider-edit-form"
          protocols={protocols}
          vendors={vendors}
        />
        <DialogFooter>
          <DialogClose render={<Button variant="outline">{tUi('cancel')}</Button>} />
          <Button type="submit" form="provider-edit-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            {tc('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
