'use client';

// 渠道资金页外壳：渠道/类型筛选 + 流水表（行项在 channel-fund-row-item，充值/调整弹窗分域文件）

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@tillgate/ui';
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import type { AdminChannelFundRow, ChannelOption } from '@tillgate/api-client';
import { AdjustDialog } from './adjust-dialog';
import { ChannelFundRowItem } from './channel-fund-row-item';
import { RechargeDialog } from './recharge-dialog';

export function ChannelFundsClient({
  rows,
  channels,
  total,
  initialChannelId,
  initialType,
}: {
  readonly rows: ReadonlyArray<AdminChannelFundRow>;
  readonly channels: ReadonlyArray<ChannelOption>;
  readonly total: number;
  readonly initialChannelId?: number;
  readonly initialType?: 'recharge' | 'adjust';
}) {
  const t = useTranslations('channelFunds');
  const tc = useTranslations('common');
  const [channelFilter, setChannelFilter] = useState<string>(
    initialChannelId ? String(initialChannelId) : 'all',
  );
  const [typeFilter, setTypeFilter] = useState<string>(initialType ?? 'all');
  const router = useRouter();
  const currentParams = useSearchParams();

  function applyFilter(nextChannel: string, nextType: string) {
    setChannelFilter(nextChannel);
    setTypeFilter(nextType);
    // 保留 q/排序等其余筛选，只换 channel/type 并回到第 1 页
    const qs = new URLSearchParams(currentParams.toString());
    qs.delete('page');
    if (nextChannel !== 'all') qs.set('channelId', nextChannel);
    else qs.delete('channelId');
    if (nextType !== 'all') qs.set('type', nextType);
    else qs.delete('type');
    router.push(`/dashboard/funds${qs.toString() ? `?${qs}` : ''}`);
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {/* items 同源映射：筛选回显渠道名/类型文案而非原始值 */}
          <Select
            value={channelFilter}
            onValueChange={(v) => applyFilter(v ?? '', typeFilter)}
            items={[
              { value: 'all', label: t('allChannels') },
              ...channels.map((c) => ({ value: String(c.id), label: c.name })),
            ]}
          >
            <SelectTrigger className="w-48">
              <SelectValue placeholder={t('allChannels')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('allChannels')}</SelectItem>
              {channels.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={typeFilter}
            onValueChange={(v) => applyFilter(channelFilter, v ?? '')}
            items={[
              { value: 'all', label: tc('allTypes') },
              { value: 'recharge', label: t('recharge') },
              { value: 'adjust', label: t('adjust') },
            ]}
          >
            <SelectTrigger className="w-40">
              <SelectValue placeholder={tc('allTypes')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{tc('allTypes')}</SelectItem>
              <SelectItem value="recharge">{t('recharge')}</SelectItem>
              <SelectItem value="adjust">{t('adjust')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <RechargeDialog channels={channels} />
          <AdjustDialog channels={channels} />
        </div>
      </div>

      <p className="text-xs text-muted-foreground">{t('totalLine', { count: total })}</p>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">ID</TableHead>
            <TableHead className="w-40">{tc('time')}</TableHead>
            <TableHead>{t('channel')}</TableHead>
            <TableHead className="w-20">{tc('type')}</TableHead>
            <TableHead className="text-right">{t('amount')}</TableHead>
            <TableHead className="text-right">{t('balanceAfter')}</TableHead>
            <TableHead>{t('orderNo')}</TableHead>
            <TableHead>{t('voucher')}</TableHead>
            <TableHead>{t('operator')}</TableHead>
            <TableHead>{tc('remark')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={10} className="h-24 text-center text-muted-foreground">
                {t('noEntries')}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((r) => <ChannelFundRowItem key={r.id} row={r} />)
          )}
        </TableBody>
      </Table>
    </div>
  );
}
