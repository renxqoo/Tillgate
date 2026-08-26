'use client';

// 编辑费率卡弹窗（受控 open，由费率卡表格行操作打开）

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

import type { AdminRateCardRow } from '@tillgate/api-client';
import { useActionResult } from '@/components/action-toast';
import { buildSchema, RateCardForm } from './rate-card-form';

export function EditRateCardDialog({
  card,
  open,
  onOpenChange,
}: {
  card: AdminRateCardRow;
  /** 受控 open：由行操作菜单项打开 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('rateCards');
  const tc = useTranslations('common');
  const tUi = useTranslations('ui');
  const notify = useActionResult();
  const [pending, startTransition] = useTransition();
  const editSchema = buildSchema(t).extend({
    status: z.coerce.number().int(),
  });
  type FormValues = z.input<typeof editSchema>;
  const form = useForm<FormValues>({
    resolver: zodResolver(editSchema) as never,
    defaultValues: {
      name: card.name,
      coefficient: card.coefficient,
      description: card.description ?? '',
      status: card.status,
    },
  });

  function onSubmit(values: FormValues) {
    startTransition(async () => {
      const { updateRateCardAction } = await import('@/server/rate-cards-actions');
      const res = await updateRateCardAction(card.id, {
        name: values.name,
        coefficient: values.coefficient,
        description: values.description?.trim() || undefined,
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
            <PencilIcon /> {t('editTitle', { name: card.name })}
          </DialogTitle>
        </DialogHeader>
        <RateCardForm form={form} onSubmit={onSubmit} formId="rc-edit-form" isEdit />
        <DialogFooter>
          <DialogClose render={<Button variant="outline">{tUi('cancel')}</Button>} />
          <Button type="submit" form="rc-edit-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            {tc('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
