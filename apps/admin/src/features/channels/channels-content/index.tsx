'use client';

// 渠道管理：表格 + 行项（探测/编辑/删除/恢复）；弹窗在 channel-dialogs、批量导入在 import-channels-dialog

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@tillgate/ui';
import { useTranslations } from 'next-intl';
import type { AdminChannelRow, ProviderOption } from '@tillgate/api-client';
import { ChannelRowItem } from './channel-row-item';

export { CreateChannelDialog } from './create-channel-dialog';
export { ImportChannelsDialog } from './import-channels-dialog';

export function ChannelsTable({
  channels,
  providers,
}: {
  readonly channels: ReadonlyArray<AdminChannelRow>;
  readonly providers: ReadonlyArray<ProviderOption>;
}) {
  const t = useTranslations('channels');
  const tc = useTranslations('common');
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{tc('name')}</TableHead>
          <TableHead>{t('provider')}</TableHead>
          <TableHead>Base URL</TableHead>
          <TableHead>{t('models')}</TableHead>
          <TableHead className="text-right">{t('weightPriority')}</TableHead>
          <TableHead className="text-right">{t('budget')}</TableHead>
          <TableHead>{tc('status')}</TableHead>
          <TableHead className="text-right">{t('failCount')}</TableHead>
          <TableHead className="w-16 text-center">{tc('actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {channels.length === 0 ? (
          <TableRow>
            <TableCell colSpan={9} className="h-24 text-center text-muted-foreground">
              {t('noChannels')}
            </TableCell>
          </TableRow>
        ) : (
          channels.map((c) => <ChannelRowItem key={c.id} channel={c} providers={providers} />)
        )}
      </TableBody>
    </Table>
  );
}
