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
} from '@tokenlens/ui';
import type { CurrentSubscription, PlanRow } from '@tokenlens/api-client';

import { actionResult } from '@/features/shared/action-result';
import { changeSubscriptionAction, purchaseSubscriptionAction } from '@/server/actions/subscription';

import { fmtYuan, InfoRow } from './current-subscription';
import { planPeriodLabel } from './plan-format';

export function PlanCard({
  plan,
  subscription,
}: {
  plan: PlanRow;
  subscription: CurrentSubscription | null;
}) {
  const t = useTranslations('subscription');
  const locale = useLocale();

  // 卡片只出现在两种语境：无订阅→购买；有订阅→更高档→升级。
  const isUpgrade = subscription !== null;

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <span className="font-semibold">{plan.name}</span>
        <span className="text-xs text-muted-foreground">{planPeriodLabel(plan.periodDays, t)}</span>
      </div>
      <div className="space-y-0.5">
        <div className="text-xs text-muted-foreground">
          {plan.allowSeats ? t('pricePerSeatLabel') : t('priceLabel')}
        </div>
        <div className="text-2xl font-semibold tabular-nums">{fmtYuan(plan.price, locale)}</div>
        <div className="text-xs text-muted-foreground tabular-nums">
          {t('pointsValue', { points: fmtYuan(plan.price, locale) })}
        </div>
      </div>

      {isUpgrade ? (
        <UpgradeAction plan={plan} subscription={subscription!} />
      ) : (
        <PurchaseAction plan={plan} />
      )}
    </div>
  );
}

function PurchaseAction({ plan }: { plan: PlanRow }) {
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

function UpgradeAction({
  plan,
  subscription,
}: {
  plan: PlanRow;
  subscription: CurrentSubscription;
}) {
  const t = useTranslations('subscription');
  const tUi = useTranslations('ui');
  const locale = useLocale();
  const [quantity, setQuantity] = useState(String(subscription.quantity));
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  // 弹窗展示用席位（非法值回退到当前席位）
  const qty = plan.allowSeats
    ? Math.max(subscription.quantity, Number(quantity) || subscription.quantity)
    : subscription.quantity;
  const total = Number(plan.price) * qty;
  const diff = Math.max(0, total - Number(subscription.remainingValue));

  function upgrade() {
    // 非席位套餐固定沿用当前席位；席位套餐不能少于当前（防缩容）
    const n = plan.allowSeats ? Number(quantity) : subscription.quantity;
    if (plan.allowSeats && (!Number.isInteger(n) || n < subscription.quantity)) {
      toast.error(t('seatsNotLessToast', { count: subscription.quantity }));
      return;
    }
    startTransition(async () => {
      const res = await changeSubscriptionAction(subscription.id, {
        targetPlanId: plan.id,
        quantity: n,
      });
      if (!actionResult(res, t('upgradeFailedToast'), t('upgradeSuccessToast'))) return;
      setOpen(false);
    });
  }

  return (
    <div className="mt-auto">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger render={<Button className="w-full" />}>{t('upgrade')}</DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('upgradeTitle')}</DialogTitle>
            <DialogDescription>{t('upgradeDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {plan.allowSeats ? (
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">{t('labelSeats')}</label>
                <Input
                  type="number"
                  min={subscription.quantity}
                  step="1"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  className="w-full"
                />
              </div>
            ) : null}
            <div className="space-y-2 rounded-lg border p-3 text-sm">
              <InfoRow label={t('labelUpgradePath')}>
                {subscription.planName}
                {subscription.allowSeats
                  ? ` ${t('seatsSuffix', { count: subscription.quantity })}`
                  : ''}{' '}
                → {plan.name}
                {plan.allowSeats ? ` ${t('seatsSuffix', { count: qty })}` : ''}
              </InfoRow>
              <InfoRow label={t('labelTargetTotal')}>{fmtYuan(String(total), locale)}</InfoRow>
              <InfoRow label={t('labelRemainingValue')}>
                {fmtYuan(subscription.remainingValue, locale)}
              </InfoRow>
              <InfoRow label={t('labelDiff')} emphasize>
                {fmtYuan(String(diff), locale)}
              </InfoRow>
            </div>
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>{tUi('cancel')}</DialogClose>
            <Button disabled={pending} onClick={upgrade}>
              {pending && <Loader2Icon className="animate-spin" />}
              {t('confirmUpgrade')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
