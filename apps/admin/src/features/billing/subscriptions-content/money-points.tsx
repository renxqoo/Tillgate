'use client';

import { useTranslations } from 'next-intl';

import { formatMoney, formatPoints } from '@/lib/formatters';

/** 钱 + 积分并列展示（纯展示层，积分 = 元 × 100）。 */
export function MoneyPoints({ value }: { value: string }) {
  const tUi = useTranslations('ui');
  return (
    <span className="tabular-nums">
      <span className="font-medium">¥{formatMoney(value)}</span>
      <span className="ml-1.5 text-xs text-muted-foreground">
        {formatPoints(value)} {tUi('points')}
      </span>
    </span>
  );
}
