'use client';

// 费率卡表格壳（行项在 rate-card-row-item，创建/编辑弹窗与表单在同目录分域文件）

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@tillgate/ui';
import { useTranslations } from 'next-intl';
import type { AdminRateCardRow } from '@tillgate/api-client';
import { RateCardRowItem } from './rate-card-row-item';

export { CreateRateCardDialog } from './create-rate-card-dialog';

export function RateCardsTable({ cards }: { readonly cards: ReadonlyArray<AdminRateCardRow> }) {
  const t = useTranslations('rateCards');
  const tc = useTranslations('common');
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{tc('name')}</TableHead>
          <TableHead className="text-right">{t('coefficient')}</TableHead>
          <TableHead>{t('descriptionLabel')}</TableHead>
          <TableHead className="w-24">{tc('status')}</TableHead>
          <TableHead className="w-44">{tc('updatedAt')}</TableHead>
          <TableHead className="w-16 text-center">{tc('actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {cards.length === 0 ? (
          <TableRow>
            <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
              {t('noRateCards')}
            </TableCell>
          </TableRow>
        ) : (
          cards.map((c) => <RateCardRowItem key={c.id} card={c} />)
        )}
      </TableBody>
    </Table>
  );
}
