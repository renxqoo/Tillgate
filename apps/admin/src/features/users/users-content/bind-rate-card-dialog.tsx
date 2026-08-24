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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@tillgate/ui';
import type * as React from 'react';
import { useState, useTransition } from 'react';

import { BanknoteIcon, Loader2Icon, PencilIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { RateCardOption, AdminUserRow } from '@tillgate/api-client';
import { useActionResult } from '@/components/action-toast';

export function BindRateCardDialog({
  user,
  rateCards,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  user: AdminUserRow;
  rateCards: ReadonlyArray<RateCardOption>;
  trigger?: React.ReactElement | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useTranslations('users');
  const tc = useTranslations('common');
  const tUi = useTranslations('ui');
  const notify = useActionResult();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState<string>(
    user.rateCardId === null ? 'none' : String(user.rateCardId),
  );

  function onSubmit() {
    startTransition(async () => {
      const targetId = value === 'none' ? null : Number(value);
      const { bindRateCardAction } = await import('@/server/users-actions');
      const res = await bindRateCardAction(user.id, targetId);
      if (!notify(res, t('bindFailed'), t('rateCardUpdated'))) return;
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger !== null ? (
        <DialogTrigger
          render={
            trigger ?? (
              <Button
                size="icon-sm"
                variant="ghost"
                title={t('bindRateCard')}
                aria-label={t('bindRateCard')}
              >
                <BanknoteIcon />
              </Button>
            )
          }
        />
      ) : null}
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PencilIcon /> {t('bindTitle', { subject: user.subject })}
          </DialogTitle>
          <DialogDescription>{t('bindDescription')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Select value={value} onValueChange={(v) => setValue(v ?? '')}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t('selectRateCard')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t('unbind')}</SelectItem>
              {rateCards.map((r) => (
                <SelectItem key={r.id} value={String(r.id)}>
                  {r.name}（×{r.coefficient}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">{tUi('cancel')}</Button>} />
          <Button disabled={pending} onClick={onSubmit}>
            {pending && <Loader2Icon className="animate-spin" />}
            {tc('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
