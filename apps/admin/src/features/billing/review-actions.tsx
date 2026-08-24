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
  DialogTrigger,
  Input,
  Label,
} from '@tillgate/ui';
import { useId, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  abandonDeadBillingRequest,
  retryDeadBillingRequest,
} from '@/server/billing-operations-actions';

export function ReviewActions(props: { requestId: string; revision: number; status: 'dead' }) {
  const t = useTranslations('billingOperations');
  const tc = useTranslations('common');
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, startTransition] = useTransition();

  function handleOpenChange(nextOpen: boolean) {
    if (pending && !nextOpen) return;
    setOpen(nextOpen);
    if (!nextOpen) setReason('');
  }

  const run = (kind: 'retry' | 'abandon', successMessage: string) => {
    if (!reason.trim()) {
      toast.error(t('reasonRequired'));
      return;
    }
    startTransition(async () => {
      const input = {
        requestId: props.requestId,
        expectedRevision: props.revision,
        reason,
      };
      const result =
        kind === 'retry'
          ? await retryDeadBillingRequest(input)
          : await abandonDeadBillingRequest(input);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success(successMessage);
      setReason('');
      setOpen(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            {tc('actions')}
          </Button>
        }
      />
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('reviewActionTitle')}</DialogTitle>
          <DialogDescription>
            {t('reviewActionDescription', { requestId: props.requestId })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor={reasonId}>{t('reason')}</Label>
          <Input
            id={reasonId}
            autoFocus
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t('reasonPlaceholder')}
            maxLength={1000}
          />
        </div>
        <DialogFooter>
          <DialogClose
            render={
              <Button variant="outline" disabled={pending}>
                {tc('close')}
              </Button>
            }
          />
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => run('retry', t('retryQueued'))}
          >
            {t('retry')}
          </Button>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => run('abandon', t('abandoned'))}
          >
            {t('abandon')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
