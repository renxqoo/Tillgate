import { requirePermission } from '@/server/get-admin';
import type { DataTableColumn } from '@/components/data-table';

import { DataTable } from '@/components/data-table';
import { StatusPill } from '@/components/status-pill';
import { Badge } from '@tokenlens/ui';
import { UserCogIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { adminApi } from '@/server/admin-api';
import { fmtDateTime } from '@/lib/formatters';
import { ListPage } from '@/components/list-page';

import { AdminCreateForm } from '@/features/admins/admin-create-form';
import { AdminRowActions } from '@/features/admins/admin-row-actions';

export const dynamic = 'force-dynamic';

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

export default async function AdminsPage() {
  const me = await requirePermission('admins:read');
  const t = await getTranslations('admins');
  const tc = await getTranslations('common');
  const data = await adminApi()
    .get<{ rows?: AdminRow[] }>('/v1/admins')
    .catch(() => null);

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
      description={t('description')}
      icon={<UserCogIcon className="size-5 text-muted-foreground" />}
    >
      {me.permissions?.includes('admins:write') ? <AdminCreateForm /> : null}
      <DataTable
        rowKey={(r) => r.id}
        rows={data?.rows ?? []}
        columns={columns}
        empty={t('empty')}
      />
    </ListPage>
  );
}
