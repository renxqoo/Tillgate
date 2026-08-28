'use client';

// 单用户透支地板弹窗（列表行菜单与详情页操作组共用；manual 来源，批量刷默认永不覆盖）

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

import { LandmarkIcon, Loader2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';

import { moneyText } from '@/lib/forms';
import { formatMoney } from '@/lib/formatters';

import type { AdminUserRow } from '@tillgate/api-client';
import { useActionResult } from '@/components/action-toast';

export function DebitFloorDialog({
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
  // 校验消息走目录：schema 在组件内用 t 构造（0 合法 = 不透支，禁负）
  const floorSchema = z.object({
    floor: moneyText({ message: t('debitFloorInvalid') }),
  });
  const form = useForm<{ floor: string }>({
    resolver: zodResolver(floorSchema) as never,
    defaultValues: { floor: '' },
  });

  function onSubmit(values: { floor: string }) {
    startTransition(async () => {
      const { setDebitFloorAction } = await import('@/server/users-actions');
      const res = await setDebitFloorAction(user.id, { floor: values.floor });
      if (!notify(res, t('debitFloorFailed'), t('debitFloorSet'))) return;
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
                <LandmarkIcon /> {tc('setDebitFloor')}
              </Button>
            )
          }
        />
      ) : null}
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LandmarkIcon /> {t('debitFloorTitle', { subject: user.subject })}
          </DialogTitle>
          <DialogDescription>
            {t('debitFloorDescription', {
              floor: formatMoney(user.debitFloor),
              source: tc(user.debitFloorSource === 'manual' ? 'debitFloorManual' : 'debitFloorDefault'),
            })}
          </DialogDescription>
        </DialogHeader>
        <form id="floor-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FieldGroup>
            <NumberField
              control={form.control}
              name="floor"
              label={tc('debitFloor')}
              id={`floor-${user.id}`}
              step="0.01"
            />
          </FieldGroup>
        </form>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">{tUi('cancel')}</Button>} />
          <Button type="submit" form="floor-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            {tc('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
