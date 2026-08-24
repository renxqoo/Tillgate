'use client';

import { useState, useTransition } from 'react';

import { Loader2Icon, SparklesIcon } from 'lucide-react';
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
  Progress,
  toast,
} from '@tillgate/ui';
import type { CurrentSubscription } from '@tillgate/api-client';

import { formatDateTime, formatMoney } from '@/features/shared/format';
import { actionResult } from '@/features/shared/action-result';
import { changeSubscriptionAction, renewSubscriptionAction } from '@/server/actions/subscription';

import { planPeriodLabel } from './plan-format';

/** 元展示去尾零：¥100.00 → ¥100（整额/价格类展示） */
export function fmtYuan(value: string, locale: string): string {
  return formatMoney(value, locale).replace(/\.?0+$/, '');
}

/** 已用占比（0-100），仅用于进度条展示。 */
export function usagePercent(used: string, quota: string): number {
  const u = Number(used);
  const q = Number(quota);
  if (!Number.isFinite(u) || !Number.isFinite(q) || q <= 0) return 0;
  return Math.min(100, Math.max(0, (u / q) * 100));
}

export function InfoRow({
  label,
  children,
  emphasize = false,
}: {
  label: string;
  children: React.ReactNode;
  emphasize?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={`text-right tabular-nums ${emphasize ? 'font-semibold text-foreground' : 'font-medium'}`}
      >
        {children}
      </span>
    </div>
  );
}

export function CurrentSubscriptionCard({ sub }: { sub: CurrentSubscription }) {
  const t = useTranslations('subscription');
  const locale = useLocale();
  const pct = usagePercent(sub.usedAmount, sub.quotaAmount);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <SparklesIcon className="size-4 text-muted-foreground" />
          <span className="font-medium">{sub.planName}</span>
          {sub.allowSeats ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {t('seatsBadge', { count: sub.quantity })}
            </span>
          ) : null}
        </div>
        <span className="text-xs text-muted-foreground">
          {t('periodRange', {
            start: formatDateTime(sub.startAt, locale),
            end: formatDateTime(sub.endAt, locale),
          })}
        </span>
      </div>

      <div className="space-y-1.5">
        <Progress value={pct} />
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{t('usedPercent', { pct: pct.toFixed(1) })}</span>
          <span className="tabular-nums">
            {t('remainingPoints')}{' '}
            <span className="font-medium text-foreground">
              {formatMoney(sub.remainingAmount, locale)}
            </span>
          </span>
        </div>
      </div>

      {sub.allowSeats ? <SeatUpgrade sub={sub} /> : null}
    </div>
  );
}

/** 续费按钮（「当前订阅」卡片右上角），点击弹确认框。 */
export function RenewButton({ sub }: { sub: CurrentSubscription }) {
  const t = useTranslations('subscription');
  const tUi = useTranslations('ui');
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function confirm() {
    startTransition(async () => {
      const res = await renewSubscriptionAction(sub.id);
      if (!actionResult(res, t('renewFailed'), t('renewSuccessToast'))) return;
      setOpen(false);
    });
  }

  // 续费预览口径与服务端 renewalStart 一致：未到期从旧 endAt 顺延，已到期从 now 起算。
  // periodDays/endAt 异常缺失时兜底，绝不让 newEndAt 变 Invalid Date。
  const oldEndTs = new Date(sub.endAt).getTime();
  const baseTs = Number.isFinite(oldEndTs) ? Math.max(oldEndTs, Date.now()) : Date.now();
  const periodMs = Number.isFinite(sub.periodDays) ? sub.periodDays * 86_400_000 : 0;
  const newEndAt = new Date(baseTs + periodMs);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>{t('renew')}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('renewTitle')}</DialogTitle>
          <DialogDescription>{t('renewDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 rounded-lg border p-3 text-sm">
          <InfoRow label={t('labelPlan')}>
            {sub.planName}
            {sub.allowSeats ? ` ${t('seatsSuffix', { count: sub.quantity })}` : ''}
          </InfoRow>
          <InfoRow label={t('labelPeriod')}>{planPeriodLabel(sub.periodDays, t)}</InfoRow>
          <InfoRow label={t('labelCurrentEnd')}>{formatDateTime(sub.endAt, locale)}</InfoRow>
          <InfoRow label={t('labelNewEnd')}>
            {formatDateTime(newEndAt.toISOString(), locale)}
          </InfoRow>
          <InfoRow label={t('labelRenewAmount')} emphasize>
            {fmtYuan(sub.renewPrice, locale)}
          </InfoRow>
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>{tUi('cancel')}</DialogClose>
          <Button disabled={pending} onClick={confirm}>
            {pending && <Loader2Icon className="animate-spin" />}
            {t('confirmRenew')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 团队套餐：在当前订阅基础上加席位。 */
function SeatUpgrade({ sub }: { sub: CurrentSubscription }) {
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
