'use client';

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

import { Loader2Icon, ShieldOffIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { AdminUserRow } from '@tillgate/api-client';
import { useActionResult } from '@/components/action-toast';

/**
 * 封禁确认弹窗（替代原生 prompt+confirm）：输入封禁原因（可选）后确认执行。
 * 解封不需要确认，仍走菜单直执行路径。
 */
export function FreezeDialog({
  user,
  open: controlledOpen,
  onOpenChange,
}: {
  user: AdminUserRow;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useTranslations('users');
  const tUi = useTranslations('ui');
  const notify = useActionResult();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [reason, setReason] = useState('');
  const [pending, startTransition] = useTransition();

  function submit() {
    startTransition(async () => {
      const { setUserStatusAction } = await import('@/server/users-actions');
      const res = await setUserStatusAction(user.id, { status: 1, freezeReason: reason });
      if (!notify(res, t('banFailed'), t('bannedShort'))) return;
      setReason('');
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldOffIcon /> {t('banConfirm', { subject: user.subject })}
          </DialogTitle>
          <DialogDescription>{t('banDescription')}</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <FormItem>
            <FieldLabel htmlFor="freeze-reason">{t('freezeReasonPrompt')}</FieldLabel>
            <Input
              id="freeze-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={200}
            />
          </FormItem>
        </FieldGroup>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">{tUi('cancel')}</Button>} />
          <Button variant="destructive" onClick={submit} disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            {t('ban')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
