'use client';

// 调整余额弹窗（列表行菜单与详情页操作组共用；表单契约在 user-balance-form）

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

import { Loader2Icon, ScaleIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { moneyText } from '@/lib/forms';
import { formatMoney } from '@/lib/formatters';

import type { AdminUserRow } from '@tillgate/api-client';
import { useActionResult } from '@/components/action-toast';
import { TextareaField, type BalanceFormValues } from './user-balance-form';

export function AdjustDialog({
  user,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  user: AdminUserRow;
  /** null 表示由外部菜单控制，不渲染触发器。 */
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
  // 校验消息走目录：schema 在组件内用 t 构造
  const adjustSchema = z.object({
    amount: moneyText({ message: tUi('invalidAmount'), allowNegative: true, allowZero: false }),
    remark: z.string().optional(),
  });
  const form = useForm<BalanceFormValues>({
    resolver: zodResolver(adjustSchema) as never,
    defaultValues: { amount: '', remark: '' },
  });

  function onSubmit(values: BalanceFormValues) {
    startTransition(async () => {
      const { adjustBalanceAction } = await import('@/server/users-actions');
      const res = await adjustBalanceAction(user.id, {
        amount: values.amount,
        remark: values.remark,
      });
      if (!notify(res, t('adjustFailed'), t('adjusted'))) return;
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
                <ScaleIcon /> {t('adjust')}
              </Button>
            )
          }
        />
      ) : null}
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScaleIcon /> {t('adjustTitle', { subject: user.subject })}
          </DialogTitle>
          <DialogDescription>
            {t('adjustDescription', {
              balance: formatMoney(user.balance),
              reserved: formatMoney(user.reservedBalance),
              available: formatMoney(user.availableBalance),
            })}
          </DialogDescription>
        </DialogHeader>
        <form id="adj-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FieldGroup>
            <NumberField
              control={form.control}
              name="amount"
              label={t('amountSigned')}
              id="adj-amount"
              step="0.01"
            />
            <TextareaField name="remark" form={form} label={tc('remark')} id="adj-remark" />
          </FieldGroup>
        </form>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">{tUi('cancel')}</Button>} />
          <Button type="submit" form="adj-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            {t('confirmAdjust')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
