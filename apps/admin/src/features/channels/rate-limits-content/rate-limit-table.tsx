'use client';

// 限流表格：按实体 kind 显隐信用/日限额列，编辑经 onEdit 回调上抛

import {
  DropdownMenuItem,
  RowActions,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@tillgate/ui';
import { GaugeIcon, PencilIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { RateLimitItem, RateLimitKind } from '@/features/channels/rate-limit-types';
import { fmtLimit, fmtMoney } from './rate-limit-format';

export function RateLimitTable({
  items,
  kind,
  onEdit,
}: {
  items: RateLimitItem[];
  kind: RateLimitKind;
  onEdit: (kind: RateLimitKind, item: RateLimitItem) => void;
}) {
  const tc = useTranslations('common');
  const tUi = useTranslations('ui');
  if (items.length === 0) {
    return <p className="p-8 text-center text-sm text-muted-foreground">{tUi('empty')}</p>;
  }
  const showCredit = kind === 'user';
  const showDailySpend = kind === 'user' || kind === 'key';
  return (
    <Table>
      <TableHeader className="bg-card">
        <TableRow>
          <TableHead>{tc('name')}</TableHead>
          <TableHead className="text-right">RPM</TableHead>
          <TableHead className="text-right">TPM</TableHead>
          {showCredit ? <TableHead className="text-right">{tc('creditLimit')}</TableHead> : null}
          {showDailySpend ? (
            <TableHead className="text-right">{tc('dailySpendLimit')}</TableHead>
          ) : null}
          <TableHead className="text-center">{tc('status')}</TableHead>
          <TableHead className="w-16 text-center">{tc('actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((it) => (
          <TableRow key={`${kind}-${it.id}`}>
            <TableCell>
              <div className="flex items-center gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <GaugeIcon className="size-4" />
                </div>
                <div className="min-w-0">
                  <div className="truncate font-medium">{it.label}</div>
                  {it.sublabel ? (
                    <div className="truncate font-mono text-xs text-muted-foreground">
                      {it.sublabel}
                    </div>
                  ) : null}
                </div>
              </div>
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {fmtLimit(it.rpmLimit) || tc('unlimited')}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {fmtLimit(it.tpmLimit) || tc('unlimited')}
            </TableCell>
            {showCredit ? (
              <TableCell className="text-right tabular-nums">
                {fmtMoney(it.creditLimit, tc('unlimited'))}
              </TableCell>
            ) : null}
            {showDailySpend ? (
              <TableCell className="text-right tabular-nums">
                {fmtMoney(it.dailySpendLimit, tc('unlimited'))}
              </TableCell>
            ) : null}
            <TableCell className="text-center">
              {it.status === 0 ? (
                <span className="text-xs text-emerald-600">{tc('active')}</span>
              ) : (
                <span className="text-xs text-destructive">{tc('stopped')}</span>
              )}
            </TableCell>
            <TableCell className="w-16 text-center">
              <RowActions label={tc('actions')}>
                <DropdownMenuItem onClick={() => onEdit(kind, it)}>
                  <PencilIcon /> {tc('edit')}
                </DropdownMenuItem>
              </RowActions>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
