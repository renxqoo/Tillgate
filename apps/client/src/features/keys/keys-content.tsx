'use client';

// Key 列表表格壳：表头 + 行渲染（行操作见 key-row-actions，创建弹窗见 create-key-dialog）

import { KeyRoundIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@tillgate/ui';
import type { KeyRow } from '@tillgate/api-client';

import { formatDateTime, formatMoney } from '@/features/shared/format';

import { KeyRowActions } from './key-row-actions';
import { SourceBadge } from './source-badge';
import { StatusBadge } from './status-badge';

export function KeysTable({
  keys,
  subscriptionLabels,
}: {
  readonly keys: ReadonlyArray<KeyRow>;
  readonly subscriptionLabels: ReadonlyMap<number, string>;
}) {
  const t = useTranslations('keys');
  const tCommon = useTranslations('common');
  const locale = useLocale();

  const fmtLimit = (v: number | null): string =>
    v === null ? tCommon('unlimited') : v.toLocaleString('en-US');
  const fmtMoney = (v: string | null): string =>
    v === null ? tCommon('unlimited') : formatMoney(v, locale);

  return (
    <Table>
      <TableHeader className="bg-card">
        <TableRow>
          <TableHead>{tCommon('name')}</TableHead>
          <TableHead>{t('colType')}</TableHead>
          <TableHead>{t('colKey')}</TableHead>
          <TableHead className="text-right">RPM</TableHead>
          <TableHead className="text-right">TPM</TableHead>
          <TableHead className="text-right">{t('colDailyLimit')}</TableHead>
          <TableHead>{tCommon('status')}</TableHead>
          <TableHead>{tCommon('createdAt')}</TableHead>
          <TableHead>{t('colLastUsed')}</TableHead>
          <TableHead className="w-16 text-center">{tCommon('actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {keys.length === 0 ? (
          <TableRow>
            <TableCell colSpan={10} className="h-24 text-center text-muted-foreground">
              {t('noKeys')}
            </TableCell>
          </TableRow>
        ) : (
          keys.map((k) => (
            <TableRow key={k.id}>
              <TableCell className="min-w-56">
                <div className="flex items-center gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <KeyRoundIcon className="size-4" />
                  </div>
                  <div className="min-w-0">
                    <span className="block truncate font-medium">{k.name}</span>
                    <span className="block truncate text-sm text-muted-foreground">
                      {k.remark || k.keyPreview}
                    </span>
                  </div>
                </div>
              </TableCell>
              <TableCell>
                <SourceBadge
                  label={
                    k.subscriptionId != null
                      ? (subscriptionLabels.get(k.subscriptionId) ?? t('planFallback'))
                      : t('sourceBalance')
                  }
                  balanceLabel={t('sourceBalance')}
                />
              </TableCell>
              <TableCell>
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{k.keyPreview}</code>
              </TableCell>
              <TableCell className="text-right tabular-nums">{fmtLimit(k.rpmLimit)}</TableCell>
              <TableCell className="text-right tabular-nums">{fmtLimit(k.tpmLimit)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {fmtMoney(k.dailySpendLimit)}
              </TableCell>
              <TableCell>
                <StatusBadge status={k.status} />
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {formatDateTime(k.createdAt, locale)}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {formatDateTime(k.lastUsedAt, locale)}
              </TableCell>
              <TableCell className="w-16 text-center">
                <KeyRowActions keyRow={k} />
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
