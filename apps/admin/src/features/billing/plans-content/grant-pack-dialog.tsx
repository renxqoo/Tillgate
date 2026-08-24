'use client';

// 发放加油包弹窗（受控 open，由套餐行操作打开）

import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FieldGroup,
  FieldLabel,
  FormItem,
  Input,
} from '@tillgate/ui';
import { useState, useTransition } from 'react';

import { GiftIcon, Loader2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { formatMoney, formatPoints } from '@/lib/formatters';

import type { PlanRow } from '@tillgate/api-client';
import { useActionResult } from '@/components/action-toast';

/** 发放加油包：输入 userId，扣 pack 售价、给用户余额加额度。 */
export function GrantPackDialog({
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
  const [userId, setUserId] = useState('');

  function submit() {
    const uid = Number(userId);
    if (!Number.isInteger(uid) || uid <= 0) {
      toast.error(t('invalidUserId'));
      return;
    }
    startTransition(async () => {
      const { grantPackAction } = await import('@/server/plans-actions');
      const res = await grantPackAction(plan.id, uid);
      if (!notify(res, t('grantFailed'), t('granted'))) return;
      setUserId('');
      onOpenChange(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setUserId('');
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GiftIcon /> {t('grantTitle', { name: plan.name })}
          </DialogTitle>
          <DialogDescription>
            {t('grantDescription', {
              price: formatMoney(plan.price),
              points: formatPoints(plan.quotaAmount),
            })}
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <FormItem>
            <FieldLabel htmlFor="grant-user-id">{tc('userId')}</FieldLabel>
            <Input
              id="grant-user-id"
              type="number"
              min={1}
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder={t('userIdPlaceholder')}
            />
          </FormItem>
        </FieldGroup>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">{tUi('cancel')}</Button>} />
          <Button onClick={submit} disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            {t('confirmGrant')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
