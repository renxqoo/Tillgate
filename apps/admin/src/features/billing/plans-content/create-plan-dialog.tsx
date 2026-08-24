'use client';

// 创建套餐弹窗（编辑弹窗在 edit-plan-dialog，共享表单在 plan-form）

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

import { GemIcon, Loader2Icon, PlusCircleIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';

import { useActionResult } from '@/components/action-toast';
import { buildCreateSchema, PlanForm, type PlanFormValues } from './plan-form';

export function CreatePlanDialog() {
  const t = useTranslations('plans');
  const tc = useTranslations('common');
  const tUi = useTranslations('ui');
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const createSchema = buildCreateSchema(t);
  type FormValues = z.input<typeof createSchema>;
  const form = useForm<FormValues>({
    resolver: zodResolver(createSchema) as never,
    defaultValues: {
      name: '',
      kind: 'subscription',
      sortOrder: '',
      price: '',
      periodDays: '30',
      quotaAmount: '',
      allowSeats: false,
    },
  });

  function onSubmit(values: FormValues) {
    startTransition(async () => {
      const { createPlanAction } = await import('@/server/plans-actions');
      const res = await createPlanAction({
        name: values.name,
        kind: values.kind,
        sortOrder: values.sortOrder.trim() === '' ? null : Number(values.sortOrder),
        price: values.price,
        periodDays: values.kind === 'pack' ? 0 : Number(values.periodDays),
        quotaAmount: values.quotaAmount,
        allowSeats: values.allowSeats,
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
            <GemIcon /> {t('create')}
          </DialogTitle>
          <DialogDescription>{t('createDescription')}</DialogDescription>
        </DialogHeader>
        <PlanForm
          form={form as unknown as UseFormReturn<PlanFormValues>}
          onSubmit={onSubmit}
          formId="plan-form"
        />
        <DialogFooter>
          <DialogClose render={<Button variant="outline">{tUi('cancel')}</Button>} />
          <Button type="submit" form="plan-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            {tc('create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
