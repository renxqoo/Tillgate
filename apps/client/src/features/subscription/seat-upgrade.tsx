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
import type { CurrentSubscription } from '@tillgate/api-client';

import { actionResult } from '@/features/shared/action-result';
import { changeSubscriptionAction } from '@/server/actions/subscription';

import { InfoRow } from './info-row';
import { fmtYuan } from './plan-format';

/** 团队套餐：在当前订阅基础上加席位。 */
export function SeatUpgrade({ sub }: { sub: CurrentSubscription }) {
  const t = useTranslations('subscription');
  const tUi = useTranslations('ui');
  const locale = useLocale();
  const [seatQty, setSeatQty] = useState(String(sub.quantity + 1));
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  // 弹窗展示用席位（非法值回退到当前 +1）
  const qty = Math.max(sub.quantity + 1, Number(seatQty) || sub.quantity + 1);
  const total = Number(sub.planPrice) * qty;
  const diff = Math.max(0, total - Number(sub.remainingValue));

  function addSeat() {
    const n = Number(seatQty);
    if (!Number.isInteger(n) || n <= sub.quantity) {
      toast.error(t('seatsGreaterToast', { count: sub.quantity }));
      return;
    }
    startTransition(async () => {
      const res = await changeSubscriptionAction(sub.id, {
        targetPlanId: sub.planId,
        quantity: n,
      });
      if (!actionResult(res, t('scaleFailedToast'), t('scaleSuccessToast'))) return;
      setOpen(false);
    });
  }

  return (
    <div className="flex items-center gap-2 border-t pt-4">
      <span className="text-xs text-muted-foreground">{t('addSeats')}</span>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger render={<Button size="sm" variant="outline" />}>
          {t('scaleUp')}
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('scaleTitle')}</DialogTitle>
            <DialogDescription>{t('scaleDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t('labelSeats')}</label>
              <Input
                type="number"
                min={sub.quantity + 1}
                step="1"
                value={seatQty}
                onChange={(e) => setSeatQty(e.target.value)}
                className="w-full"
              />
            </div>
            <div className="space-y-2 rounded-lg border p-3 text-sm">
              <InfoRow label={t('labelSeats')}>
                {sub.quantity} → {qty}
              </InfoRow>
              <InfoRow label={t('labelTargetTotal')}>{fmtYuan(String(total), locale)}</InfoRow>
              <InfoRow label={t('labelRemainingValue')}>
                {fmtYuan(sub.remainingValue, locale)}
              </InfoRow>
              <InfoRow label={t('labelDiff')} emphasize>
                {fmtYuan(String(diff), locale)}
              </InfoRow>
            </div>
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>{tUi('cancel')}</DialogClose>
            <Button disabled={pending} onClick={addSeat}>
              {pending && <Loader2Icon className="animate-spin" />}
              {t('confirmScale')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
