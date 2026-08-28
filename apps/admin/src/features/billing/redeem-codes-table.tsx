'use client';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@tillgate/ui';
import { useTranslations } from 'next-intl';

import type { RedeemCodeRow } from '@tillgate/api-client';
import { CodeRowItem } from './code-row-item';

export function CodesTable({ codes }: { readonly codes: ReadonlyArray<RedeemCodeRow> }) {
  const t = useTranslations('redeemBatches');
  const tc = useTranslations('common');
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-16">ID</TableHead>
          <TableHead>{t('codeMasked')}</TableHead>
          <TableHead className="w-24">{tc('status')}</TableHead>
          <TableHead>{t('usedBy')}</TableHead>
          <TableHead className="w-40">{t('usedAt')}</TableHead>
          <TableHead className="w-40">{t('expiresAt')}</TableHead>
          <TableHead className="w-16 text-center">{tc('actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {codes.length === 0 ? (
          <TableRow>
            <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
              {t('noCodes')}
            </TableCell>
          </TableRow>
        ) : (
          codes.map((c) => <CodeRowItem key={c.id} code={c} />)
        )}
      </TableBody>
    </Table>
  );
}
