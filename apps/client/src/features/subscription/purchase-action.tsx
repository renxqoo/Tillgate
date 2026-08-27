'use client';

import { useState, useTransition } from 'react';

import { Loader2Icon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

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
  toast,
} from '@tillgate/ui';
import type { PlanRow } from '@tillgate/api-client';

import { actionResult } from '@/features/shared/action-result';
import { purchaseSubscriptionAction } from '@/server/actions/subscription';

import { InfoRow } from './info-row';
import { fmtYuan, planPeriodLabel } from './plan-format';

export function PurchaseAction({ plan }: { plan: PlanRow }) {
  const t = useTranslations('subscription');
  const tUi = useTranslations('ui');
  const locale = useLocale();
  const [quantity, setQuantity] = useState('1');
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  // 弹窗展示用席位（非法值回退到最小）
  const qty = Math.max(1, Number(quantity) || 1);
  const total = Number(plan.price) * qty;

  function purchase() {
    const n = Number(quantity);
    if (!Number.isInteger(n) || n < 1) {
      toast.error(t('seatsAtLeast1'));
      return;
    }
    startTransition(async () => {
      const res = await purchaseSubscriptionAction(plan.id, n);
      if (!actionResult(res, t('purchaseFailed'), t('purchaseSuccessToast'))) return;
      setOpen(false);
    });
  }

  return (
    <div className="mt-auto">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger render={<Button className="w-full" />}>{t('purchase')}</DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('purchaseTitle')}</DialogTitle>
            <DialogDescription>{t('purchaseDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {plan.allowSeats ? (
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">{t('labelSeats')}</label>
                <Input
                  type="number"
                  min={1}
                  step="1"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  className="w-full"
                />
              </div>
            ) : null}
            <div className="space-y-2 rounded-lg border p-3 text-sm">
              <InfoRow label={t('labelPlan')}>
                {plan.name}
                {plan.allowSeats ? ` ${t('seatsSuffix', { count: qty })}` : ''}
              </InfoRow>
              <InfoRow label={t('labelPeriod')}>{planPeriodLabel(plan.periodDays, t)}</InfoRow>
              <InfoRow label={t('labelPayable')} emphasize>
                {fmtYuan(String(total), locale)}
              </InfoRow>
            </div>
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>{tUi('cancel')}</DialogClose>
            <Button disabled={pending} onClick={purchase}>
              {pending && <Loader2Icon className="animate-spin" />}
              {t('purchaseTitle')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
