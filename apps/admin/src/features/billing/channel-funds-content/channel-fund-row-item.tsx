'use client';

// 渠道资金流水行项：类型徽章、带符号金额、凭证跳转（纯展示行，无行操作）

import { TableCell, TableRow } from '@tillgate/ui';
import { ImageIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import type { AdminChannelFundRow } from '@tillgate/api-client';
import { fmtDateTime, formatMoney } from '@/lib/formatters';
import { signedAmountTone } from '@/lib/money-tone';

function fmtSigned(v: string): string {
  const n = Number(v);
  return (n > 0 ? '+' : '') + formatMoney(v);
}

export function ChannelFundRowItem({ row }: { row: AdminChannelFundRow }) {
  const t = useTranslations('channelFunds');
  const locale = useLocale();
  return (
    <TableRow>
      <TableCell className="text-xs text-muted-foreground tabular-nums">#{row.id}</TableCell>
      <TableCell className="text-xs text-muted-foreground">{fmtDateTime(row.createdAt)}</TableCell>
      <TableCell className="font-medium">{row.channelName}</TableCell>
      <TableCell>
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
            row.type === 'recharge'
              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
              : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
          }`}
        >
          {row.type === 'recharge' ? t('recharge') : t('adjust')}
        </span>
      </TableCell>
      <TableCell
        className={`text-right font-medium tabular-nums ${signedAmountTone(row.amount, locale)}`}
      >
        {fmtSigned(row.amount)}
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatMoney(row.balanceAfter)}</TableCell>
      <TableCell className="text-xs text-muted-foreground">{row.orderNo ?? '—'}</TableCell>
      <TableCell>
        {row.voucher ? (
          <a href={`/v1/vouchers/${row.voucher}`} target="_blank" rel="noreferrer">
            <ImageIcon className="size-4 text-muted-foreground hover:text-foreground" />
          </a>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {row.adminDisplayName ?? row.adminEmail ?? '—'}
      </TableCell>
      <TableCell className="max-w-xs text-xs text-muted-foreground">{row.remark ?? '—'}</TableCell>
    </TableRow>
  );
}
