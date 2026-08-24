import { requirePermission } from '@/server/get-admin';
import type { DataTableColumn } from '@/components/data-table';

import { DataTable } from '@/components/data-table';
import { StatusPill } from '@/components/status-pill';
import { Badge } from '@tokenlens/ui';
import { UserCogIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { ApiError, type Paginated } from '@tokenlens/api-client';
import { adminApi } from '@/server/admin-api';
import { fmtDateTime } from '@/lib/formatters';
import { ListPage } from '@/components/list-page';
import { parseListSearchParams } from '@/lib/list-query';

import { AdminCreateForm } from '@/features/admins/admin-create-form';
import { AdminRowActions } from '@/features/admins/admin-row-actions';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

interface AdminRow {
  id: number;
  email: string;
  displayName: string | null;
  role: string;
  status: number;
  twoFactorEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export default async function AdminsPage({ searchParams }: PageProps) {
  const me = await requirePermission('admins:read');
  const sp = await searchParams;
  const t = await getTranslations('admins');
  const tc = await getTranslations('common');
  const { q, page, sortBy, order } = parseListSearchParams(sp);

  let rows: AdminRow[] = [];
  let total = 0;
  let error: string | null = null;
  try {
    const query = new URLSearchParams({
      page: String(page),
      page_size: String(PAGE_SIZE),
      sort_by: sortBy ?? 'id',
      order,
    });
    if (q) query.set('q', q);
    const data = await adminApi().get<Paginated<AdminRow>>(`/v1/admins?${query.toString()}`);
    rows = data.rows ?? [];
    total = data.total ?? 0;
  } catch (e) {
    error = e instanceof ApiError ? e.message : tc('loadFailed');
  }

  const roleLabel: Record<string, string> = {
    super_admin: t('roleSuperAdmin'),
    operator: t('roleOperator'),
    finance: t('roleFinance'),
    support: t('roleSupport'),
    viewer: t('roleViewer'),
  };

  const columns: DataTableColumn<AdminRow>[] = [
    {
      key: 'email',
      header: tc('email'),
      render: (r) => <span className="font-medium">{r.email}</span>,
    },
    { key: 'displayName', header: tc('displayName'), render: (r) => r.displayName ?? '—' },
    {
      key: 'role',
      header: t('role'),
      render: (r) => (
        <Badge variant={r.role === 'super_admin' ? 'default' : 'secondary'}>
          {roleLabel[r.role] ?? r.role}
        </Badge>
      ),
    },
    {
      key: 'status',
      header: tc('status'),
      render: (r) => (
        <StatusPill tone={r.status === 0 ? 'success' : 'neutral'}>
          {r.status === 0 ? tc('enabled') : tc('disabled')}
        </StatusPill>
      ),
    },
    { key: 'lastLoginAt', header: tc('lastLogin'), render: (r) => fmtDateTime(r.lastLoginAt) },
    { key: 'createdAt', header: tc('createdAt'), render: (r) => fmtDateTime(r.createdAt) },
    {
      key: 'actions',
      header: tc('actions'),
      render: (r) => (
        <AdminRowActions id={r.id} role={r.role} status={r.status} self={r.id === me.id} />
      ),
    },
  ];

  return (
    <ListPage
      title={t('title')}
      icon={<UserCogIcon className="size-5 text-muted-foreground" />}
      description={t('description')}
      total={total}
      searchPlaceholder={t('searchPlaceholder')}
      q={q}
      searchParams={{ q, sort_by: sortBy, order: sortBy ? order : undefined }}
      actions={me.permissions?.includes('admins:write') ? <AdminCreateForm /> : null}
      error={error}
      page={page}
      pageSize={PAGE_SIZE}
    >
      <DataTable rowKey={(r) => r.id} rows={rows} columns={columns} empty={t('empty')} />
    </ListPage>
  );
}
