'use client';

// 渠道商管理表格（行项在 provider-row-item，弹窗/表单在同目录分域文件）

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@tillgate/ui';
import { useTranslations } from 'next-intl';
import type { AdminProviderRow } from '@tillgate/api-client';
import { ProviderRowItem } from './provider-row-item';

export { CreateProviderDialog } from './create-provider-dialog';

export function ProvidersTable({
  providers,
  protocols,
  vendors,
}: {
  readonly providers: ReadonlyArray<AdminProviderRow>;
  readonly protocols: ReadonlyArray<string>;
  readonly vendors: ReadonlyArray<string>;
}) {
  const t = useTranslations('providers');
  const tc = useTranslations('common');
  return (
    <Table>
      <TableHeader className="bg-card">
        <TableRow>
          <TableHead>{tc('name')}</TableHead>
          <TableHead>Base URL</TableHead>
          <TableHead className="w-40">{t('protocolVendor')}</TableHead>
          <TableHead className="w-24">{tc('status')}</TableHead>
          <TableHead className="w-44">{tc('updatedAt')}</TableHead>
          <TableHead className="w-16 text-center">{tc('actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {providers.length === 0 ? (
          <TableRow>
            <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
              {t('noProviders')}
            </TableCell>
          </TableRow>
        ) : (
          providers.map((p) => (
            <ProviderRowItem key={p.id} provider={p} protocols={protocols} vendors={vendors} />
          ))
        )}
      </TableBody>
    </Table>
  );
}
