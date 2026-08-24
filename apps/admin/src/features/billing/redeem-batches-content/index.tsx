'use client';

// 兑换码批次表格壳（行项在 batch-row-item，生成弹窗在 generate-batch-dialog）

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@tillgate/ui';
import { useTranslations } from 'next-intl';
import type { AdminBatchRow } from '@tillgate/api-client';
import { BatchRowItem } from './batch-row-item';

export { GenerateBatchDialog } from './generate-batch-dialog';

export function BatchesTable({ batches }: { readonly batches: ReadonlyArray<AdminBatchRow> }) {
  const t = useTranslations('redeemBatches');
  const tc = useTranslations('common');
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{tc('name')}</TableHead>
          <TableHead className="text-right">{t('faceValue')}</TableHead>
          <TableHead className="text-right">{t('total')}</TableHead>
          <TableHead className="text-right">{t('used')}</TableHead>
          <TableHead className="text-right">{t('usage')}</TableHead>
          <TableHead>{tc('remark')}</TableHead>
          <TableHead>{t('createdBy')}</TableHead>
          <TableHead className="w-44">{tc('createdAt')}</TableHead>
          <TableHead className="w-16 text-center">{tc('actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {batches.length === 0 ? (
          <TableRow>
            <TableCell colSpan={9} className="h-24 text-center text-muted-foreground">
              {t('noBatches')}
            </TableCell>
          </TableRow>
        ) : (
          batches.map((b) => <BatchRowItem key={b.id} batch={b} />)
        )}
      </TableBody>
    </Table>
  );
}
