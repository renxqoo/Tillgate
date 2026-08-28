'use client';

// 用户列表表格壳 + 空态（行项在 user-row-item；行弹窗在同目录 bind-rate-card-dialog 与 feature 根 *-user-dialog 文件）

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@tillgate/ui';
import { useTranslations } from 'next-intl';

import type { RateCardOption, AdminUserRow } from '@tillgate/api-client';
import { UserRowItem } from './user-row-item';

export function UsersContent({
  users,
  rateCards,
}: {
  readonly users: ReadonlyArray<AdminUserRow>;
  readonly rateCards: ReadonlyArray<RateCardOption>;
}) {
  const t = useTranslations('users');
  const tc = useTranslations('common');
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{tc('account')}</TableHead>
          <TableHead className="w-20">{tc('status')}</TableHead>
          <TableHead className="w-20">{tc('type')}</TableHead>
          <TableHead>{t('rateCard')}</TableHead>
          <TableHead className="text-right">{t('settledBalance')}</TableHead>
          <TableHead className="text-right">{t('reservedBalance')}</TableHead>
          <TableHead className="text-right">{t('availableBalance')}</TableHead>
          <TableHead className="text-right">{tc('creditLimit')}</TableHead>
          <TableHead className="text-right">{tc('debitFloor')}</TableHead>
          <TableHead className="text-right">{tc('dailySpendLimit')}</TableHead>
          <TableHead className="w-44">{tc('lastLogin')}</TableHead>
          <TableHead className="w-16 text-center">{tc('actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.length === 0 ? (
          <TableRow>
            <TableCell colSpan={11} className="h-24 text-center text-muted-foreground">
              {t('noMatch')}
            </TableCell>
          </TableRow>
        ) : (
          users.map((u) => <UserRowItem key={u.id} user={u} rateCards={rateCards} />)
        )}
      </TableBody>
    </Table>
  );
}
