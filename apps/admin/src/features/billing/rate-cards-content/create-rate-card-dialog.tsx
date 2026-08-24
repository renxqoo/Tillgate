'use client';

// 创建费率卡弹窗（编辑弹窗在 edit-rate-card-dialog）

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
import { BanknoteIcon, Loader2Icon, PlusCircleIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';

import { useActionResult } from '@/components/action-toast';
import { buildSchema, RateCardForm, type RateCardFormValues } from './rate-card-form';

export function CreateRateCardDialog() {
  const t = useTranslations('rateCards');
  const tc = useTranslations('common');
  const tUi = useTranslations('ui');
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const createSchema = buildSchema(t);
  type FormValues = z.input<typeof createSchema>;
  const form = useForm<FormValues>({
    resolver: zodResolver(createSchema) as never,
    defaultValues: { name: '', coefficient: '1', description: '' },
  });

  function onSubmit(values: FormValues) {
    startTransition(async () => {
      const { createRateCardAction } = await import('@/server/rate-cards-actions');
      const res = await createRateCardAction({
        name: values.name,
        coefficient: values.coefficient,
        description: values.description?.trim() || undefined,
      });
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
            <BanknoteIcon /> {t('create')}
          </DialogTitle>
          <DialogDescription>{t('createDescription')}</DialogDescription>
        </DialogHeader>
        <RateCardForm
          form={form as unknown as UseFormReturn<RateCardFormValues>}
          onSubmit={onSubmit}
          formId="rc-form"
        />
        <DialogFooter>
          <DialogClose render={<Button variant="outline">{tUi('cancel')}</Button>} />
          <Button type="submit" form="rc-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            {tc('create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
