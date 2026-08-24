'use client';

// 创建渠道商弹窗（编辑弹窗在 edit-provider-dialog）

import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@tillgate/ui';
import { useState, useTransition } from 'react';
import { Loader2Icon, PlusCircleIcon, ServerIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useActionResult } from '@/components/action-toast';
import { buildProviderSchema, ProviderForm, type ProviderFormValues } from './provider-form';

export function CreateProviderDialog({
  protocols,
  vendors,
}: {
  readonly protocols: ReadonlyArray<string>;
  readonly vendors: ReadonlyArray<string>;
}) {
  const t = useTranslations('providers');
  const tc = useTranslations('common');
  const tUi = useTranslations('ui');
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const schema = buildProviderSchema(t);
  const form = useForm<ProviderFormValues>({
    resolver: zodResolver(schema) as never,
    defaultValues: {
      name: '',
      baseUrl: '',
      protocol: protocols[0] ?? 'openai-compatible',
      vendor: '',
      status: 0,
    },
  });

  function onSubmit(values: ProviderFormValues) {
    startTransition(async () => {
      const { createProviderAction } = await import('@/server/providers-actions');
      const res = await createProviderAction(values);
      if (!notify(res, tc('createFailed'), tc('created'))) return;
      form.reset();
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button>
            <PlusCircleIcon />
            {t('create')}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ServerIcon /> {t('create')}
          </DialogTitle>
          <DialogDescription>{t('createDescription')}</DialogDescription>
        </DialogHeader>
        <ProviderForm
          form={form}
          onSubmit={onSubmit}
          formId="provider-form"
          protocols={protocols}
          vendors={vendors}
        />
        <DialogFooter>
          <DialogClose render={<Button variant="outline">{tUi('cancel')}</Button>} />
          <Button type="submit" form="provider-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            {tc('create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
