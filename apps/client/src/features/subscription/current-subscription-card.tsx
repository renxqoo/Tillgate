'use client';

// 当前订阅卡片：套餐/周期/用量进度 + 团队套餐加席位区（续约按钮见 renew-button）

import { SparklesIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { Progress } from '@tillgate/ui';
import type { CurrentSubscription } from '@tillgate/api-client';

import { formatDateTime, formatMoney } from '@/features/shared/format';

import { usagePercent } from './plan-format';
import { SeatUpgrade } from './seat-upgrade';

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
