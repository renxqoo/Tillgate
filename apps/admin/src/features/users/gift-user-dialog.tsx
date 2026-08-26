'use client';

// 赠送余额弹窗（列表行菜单与详情页操作组共用；表单契约在 user-balance-form）

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
  FieldGroup,
} from '@tillgate/ui';
import { NumberField } from '@/components/number-field';
import type * as React from 'react';
import { useState, useTransition } from 'react';

import { GiftIcon, Loader2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';

import { moneyText } from '@/lib/forms';

import type { AdminUserRow } from '@tillgate/api-client';
import { useActionResult } from '@/components/action-toast';
import { TextareaField, type BalanceFormValues } from './user-balance-form';

export function GiftDialog({
  user,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  user: AdminUserRow;
  trigger?: React.ReactElement | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useTranslations('users');
  const tUi = useTranslations('ui');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [pending, startTransition] = useTransition();
  const giftSchema = z.object({
    amount: moneyText({ message: tUi('invalidAmount'), allowZero: false }),
    remark: z.string().optional(),
  });
  const form = useForm<BalanceFormValues>({
    resolver: zodResolver(giftSchema) as never,
    defaultValues: { amount: '', remark: '' },
  });

  function onSubmit(values: BalanceFormValues) {
    startTransition(async () => {
      const { giftUserAction } = await import('@/server/users-actions');
      const res = await giftUserAction(user.id, {
        amount: values.amount,
        remark: values.remark,
      });
      if (!notify(res, t('giftFailed'), t('gifted'))) return;
      form.reset();
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger !== null ? (
        <DialogTrigger
          render={
            trigger ?? (
              <Button size="sm" variant="outline">
                <GiftIcon /> {t('gift')}
              </Button>
            )
          }
        />
      ) : null}
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GiftIcon /> {t('giftTitle', { subject: user.subject })}
          </DialogTitle>
          <DialogDescription>{t('giftDescription')}</DialogDescription>
        </DialogHeader>
        <form id="gift-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FieldGroup>
            <NumberField
              control={form.control}
              name="amount"
              label={t('amountPositive')}
              id="gift-amount"
              step="0.01"
            />
            <TextareaField name="remark" form={form} label={tc('remark')} id="gift-remark" />
          </FieldGroup>
        </form>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">{tUi('cancel')}</Button>} />
          <Button type="submit" form="gift-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            {t('confirmGift')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
