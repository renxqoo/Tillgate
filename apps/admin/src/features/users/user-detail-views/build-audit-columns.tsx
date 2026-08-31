import type { getTranslations } from 'next-intl/server';
import type { AuditLogRow } from '@tillgate/api-client';

import type { DataTableColumn } from '@/components/data-table';
import { LocalTime } from '@/components/local-time';

/** 审计日志表列定义 */
export function buildAuditColumns(
  t: Awaited<ReturnType<typeof getTranslations<'users'>>>,
  tc: Awaited<ReturnType<typeof getTranslations<'common'>>>,
): DataTableColumn<AuditLogRow>[] {
  return [
    {
      key: 'id',
      header: 'ID',
      sortable: true,
      headerClassName: 'w-20',
      render: (a) => <span className="text-xs text-muted-foreground tabular-nums">#{a.id}</span>,
    },
    {
      key: 'adminSubject',
      header: t('admin'),
      render: (a) => (
        <span className="text-xs">
          {a.adminSubject ?? (a.actor === 'user' ? t('userSelf') : '—')}
        </span>
      ),
    },
    {
      key: 'action',
      header: t('action'),
      sortable: true,
      headerClassName: 'w-40',
      render: (a) => <span className="text-xs font-medium">{a.action}</span>,
    },
    {
      key: 'targetType',
      header: t('targetType'),
      headerClassName: 'w-32',
      render: (a) => <span className="text-xs text-muted-foreground">{a.targetType}</span>,
    },
    {
      key: 'detail',
      header: tc('detail'),
      render: (a) => (
        <span className="block max-w-md truncate text-xs text-muted-foreground">
          {a.detail ? JSON.stringify(a.detail) : '—'}
        </span>
      ),
    },
    {
      key: 'createdAt',
      header: tc('time'),
      sortable: true,
      headerClassName: 'w-44',
      render: (a) => <LocalTime iso={a.createdAt} className="text-xs text-muted-foreground" />,
    },
  ];
}
