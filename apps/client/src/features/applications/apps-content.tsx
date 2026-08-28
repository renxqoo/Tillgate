'use client';

// 应用列表表格壳：表头 + 行渲染（行操作见 app-row-actions，创建/轮换弹窗见同目录分域文件）

import { ShieldCheckIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import {
  CopyButton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@tillgate/ui';
import type { AppRow } from '@tillgate/api-client';

import { formatDateTime } from '@/features/shared/format';

import { AppRowActions } from './app-row-actions';
import { StatusBadge } from './status-badge';

export function AppsTable({ apps }: { readonly apps: ReadonlyArray<AppRow> }) {
  const t = useTranslations('apps');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  return (
    <Table>
      <TableHeader className="bg-card">
        <TableRow>
          <TableHead>{tCommon('name')}</TableHead>
          <TableHead>{t('colClientId')}</TableHead>
          <TableHead>{t('colAppId')}</TableHead>
          <TableHead>{tCommon('status')}</TableHead>
          <TableHead>{tCommon('createdAt')}</TableHead>
          <TableHead>{t('colRotatedAt')}</TableHead>
          <TableHead className="w-16 text-center">{tCommon('actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {apps.length === 0 ? (
          <TableRow>
            <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
              {t('noApps')}
            </TableCell>
          </TableRow>
        ) : (
          apps.map((a) => (
            <TableRow key={a.id}>
              <TableCell className="min-w-56">
                <div className="flex items-center gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <ShieldCheckIcon className="size-4" />
                  </div>
                  <div className="min-w-0">
                    <span className="block truncate font-medium">{a.name}</span>
                    {a.description ? (
                      <span className="block truncate text-sm text-muted-foreground">
                        {a.description}
                      </span>
                    ) : null}
                  </div>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{a.clientId}</code>
                  <CopyButton value={a.clientId} />
                </div>
              </TableCell>
              <TableCell>
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                  {a.appId}
                </code>
              </TableCell>
              <TableCell>
                <StatusBadge status={a.status} />
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {formatDateTime(a.createdAt, locale)}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {formatDateTime(a.rotatedAt, locale)}
              </TableCell>
              <TableCell className="w-16 text-center">
                <AppRowActions app={a} />
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
