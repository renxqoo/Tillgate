'use client';

// 订阅表格壳（行项在 subscription-row-item，变更弹窗在 change-subscription-dialog）

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@tillgate/ui';
import { useTranslations } from 'next-intl';

import type { AdminSubscriptionRow } from '@tillgate/api-client';
import { SubscriptionRowItem } from './subscription-row-item';
import type { PlanOption } from './subscriptions-shared';

export type { PlanOption } from './subscriptions-shared';

export function SubscriptionsTable({
  rows,
  plans,
}: {
  readonly rows: ReadonlyArray<AdminSubscriptionRow>;
  readonly plans: ReadonlyArray<PlanOption>;
}) {
  const t = useTranslations('subscriptions');
  const tc = useTranslations('common');
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{tc('user')}</TableHead>
          <TableHead>{t('plan')}</TableHead>
          <TableHead className="w-16">{t('seats')}</TableHead>
          <TableHead className="text-right">{t('price')}</TableHead>
          <TableHead>{t('validity')}</TableHead>
          <TableHead className="text-right">{t('quota')}</TableHead>
          <TableHead className="text-right">{t('used')}</TableHead>
          <TableHead className="text-right">{t('remaining')}</TableHead>
          <TableHead className="w-20">{tc('status')}</TableHead>
          <TableHead className="w-16 text-center">{tc('actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={10} className="h-24 text-center text-muted-foreground">
              {t('noSubscriptions')}
            </TableCell>
          </TableRow>
        ) : (
          rows.map((r) => <SubscriptionRowItem key={r.id} row={r} plans={plans} />)
        )}
      </TableBody>
    </Table>
  );
}
