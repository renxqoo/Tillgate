'use client';

// 兑换码批次行项：面值/用量展示 + 详情跳转（批次详情页承载明细，无行级弹窗）

import { DropdownMenuItem, RowActions, TableCell, TableRow } from '@tillgate/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { fmtDateTime, formatMoney } from '@/lib/formatters';
import type { AdminBatchRow } from '@tillgate/api-client';

function UsageBadge({ rate }: { rate: number }) {
  let color = 'text-muted-foreground';
  if (rate >= 80) color = 'text-emerald-600 dark:text-emerald-400';
  else if (rate >= 30) color = 'text-amber-600 dark:text-amber-400';
  return <span className={`text-xs font-medium tabular-nums ${color}`}>{rate}%</span>;
}

export function BatchRowItem({ batch }: { batch: AdminBatchRow }) {
  const tc = useTranslations('common');
  const usedRate = batch.total > 0 ? Math.round((batch.usedCount / batch.total) * 100) : 0;
  return (
    <TableRow>
      <TableCell className="font-medium">
        <Link href={`/dashboard/redeem-batches/${batch.id}`} className="hover:underline">
          {batch.name}
        </Link>
        <span className="ml-1 text-xs text-muted-foreground">#{batch.id}</span>
      </TableCell>
      <TableCell className="text-right font-medium tabular-nums">
        ¥{formatMoney(batch.amount)}
      </TableCell>
      <TableCell className="text-right tabular-nums">{batch.total}</TableCell>
      <TableCell className="text-right tabular-nums">{batch.usedCount}</TableCell>
      <TableCell className="text-right">
        <UsageBadge rate={usedRate} />
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">{batch.remark ?? '—'}</TableCell>
      <TableCell className="text-xs text-muted-foreground">{batch.createdBy}</TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {fmtDateTime(batch.createdAt)}
      </TableCell>
      <TableCell className="w-16 text-center">
        <RowActions label={tc('actions')}>
          <DropdownMenuItem render={<Link href={`/dashboard/redeem-batches/${batch.id}`} />}>
            {tc('detail')}
          </DropdownMenuItem>
        </RowActions>
      </TableCell>
    </TableRow>
  );
}
