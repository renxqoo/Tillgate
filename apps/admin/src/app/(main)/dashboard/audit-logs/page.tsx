import { requirePermission } from '@/server/get-admin';
import type { DataTableColumn } from '@/components/data-table';

import { DataTable } from '@/components/data-table';
import { HistoryIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { fetchAdminList } from '@/server/admin-list';
import type { AuditLogRow } from '@tillgate/api-client';

import { ListPage } from '@/components/list-page';
import { LocalTime } from '@/components/local-time';
import { parseListSearchParams } from '@/lib/list-query';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function AuditLogsPage({ searchParams }: PageProps) {
  await requirePermission('ops:read');
  const sp = await searchParams;
  const t = await getTranslations('auditLogs');
  const tc = await getTranslations('common');
  const { q, page, sortBy, order } = parseListSearchParams(sp);
  const { rows, total, error } = await fetchAdminList<AuditLogRow>('/v1/audit-logs', {
    page,
    pageSize: PAGE_SIZE,
    sortBy,
    order,
    extra: { q },
  });

  const columns: DataTableColumn<AuditLogRow>[] = [
    {
      key: 'id',
      header: 'ID',
      sortable: true,
      headerClassName: 'w-16',
      render: (a) => <span className="text-xs text-muted-foreground tabular-nums">#{a.id}</span>,
    },
    {
      key: 'actor',
      header: t('admin'),
      render: (a) => <span className="text-xs">{a.actor ?? a.adminSubject ?? '—'}</span>,
    },
    {
      key: 'action',
      header: t('action'),
      sortable: true,
      headerClassName: 'w-48',
      render: (a) => <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{a.action}</code>,
    },
    {
      key: 'targetType',
      header: t('targetType'),
      headerClassName: 'w-32',
      render: (a) => <span className="text-xs text-muted-foreground">{a.targetType}</span>,
    },
    {
      key: 'targetId',
      header: t('targetId'),
      headerClassName: 'w-24',
      render: (a) => <span className="text-xs text-muted-foreground">{a.targetId}</span>,
    },
    {
      key: 'detail',
      header: t('detail'),
      render: (a) => (
        <span className="max-w-md truncate text-xs text-muted-foreground">
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

  return (
    <ListPage
      title={t('title')}
      icon={<HistoryIcon className="size-5 text-muted-foreground" />}
      description={t('description')}
      total={total}
      searchPlaceholder={t('searchPlaceholder')}
      q={q}
      searchParams={{ q, sort_by: sortBy, order: sortBy ? order : undefined }}
      error={error}
      page={page}
      pageSize={PAGE_SIZE}
    >
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(a) => a.id}
        sort={{ sortBy, order }}
        searchParams={{ q }}
        empty={t('noLogs')}
      />
    </ListPage>
  );
}
