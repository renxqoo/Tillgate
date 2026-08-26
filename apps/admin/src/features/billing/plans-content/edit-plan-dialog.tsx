'use client';

// 编辑套餐弹窗（受控 open，由套餐行操作打开）

import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tillgate/ui';
import { useTransition } from 'react';

import { Loader2Icon, PencilIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';

import type { PlanRow } from '@tillgate/api-client';
import { useActionResult } from '@/components/action-toast';
import { buildCreateSchema, PlanForm } from './plan-form';

export function EditPlanDialog({
  plan,
  tUi,
  open,
  onOpenChange,
}: {
  plan: PlanRow;
  tUi: ReturnType<typeof useTranslations<'ui'>>;
  /** 受控 open：由行操作菜单项打开 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('plans');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const [pending, startTransition] = useTransition();
  const editSchema = buildCreateSchema(t).extend({
    status: z.coerce.number().int(),
  });
  type FormValues = z.input<typeof editSchema>;
  const form = useForm<FormValues>({
    resolver: zodResolver(editSchema) as never,
    defaultValues: {
      name: plan.name,
      kind: plan.kind,
      sortOrder: plan.sortOrder === null ? '' : String(plan.sortOrder),
      price: plan.price,
      periodDays: String(plan.periodDays),
      quotaAmount: plan.quotaAmount,
      allowSeats: plan.allowSeats,
      status: plan.status,
    },
  });

  function onSubmit(values: FormValues) {
    startTransition(async () => {
      const { updatePlanAction } = await import('@/server/plans-actions');
      const res = await updatePlanAction(plan.id, {
        name: values.name,
        sortOrder: values.sortOrder.trim() === '' ? null : Number(values.sortOrder),
        price: values.price,
        periodDays: values.kind === 'pack' ? 0 : Number(values.periodDays),
        quotaAmount: values.quotaAmount,
        allowSeats: values.allowSeats,
        status: Number(values.status),
      });
      if (!notify(res, tc('saveFailed'), tc('saved'))) return;
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PencilIcon /> {t('editTitle', { name: plan.name })}
          </DialogTitle>
        </DialogHeader>
        <PlanForm form={form} onSubmit={onSubmit} formId="plan-edit-form" isEdit />
        <DialogFooter>
          <DialogClose render={<Button variant="outline">{tUi('cancel')}</Button>} />
          <Button type="submit" form="plan-edit-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            {tc('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
