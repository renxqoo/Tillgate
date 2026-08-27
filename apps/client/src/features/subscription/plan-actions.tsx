'use client';

import { useLocale, useTranslations } from 'next-intl';

import type { CurrentSubscription, PlanRow } from '@tillgate/api-client';

import { fmtYuan, planPeriodLabel } from './plan-format';
import { PurchaseAction } from './purchase-action';
import { UpgradeAction } from './upgrade-action';

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

      {isUpgrade && subscription !== null ? (
        <UpgradeAction plan={plan} subscription={subscription} />
      ) : (
        <PurchaseAction plan={plan} />
      )}
    </div>
  );
}
