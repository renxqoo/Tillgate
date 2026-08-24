import { requirePermission } from '@/server/get-admin';
import type { DataTableColumn } from '@/components/data-table';
import { Button, Card, CardContent } from '@tillgate/ui';
import { DataTable } from '@/components/data-table';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeftIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { ApiError } from '@tillgate/api-client';
import type { AdminRateCardRow, AdminUserRow } from '@tillgate/api-client';
import { fmtBalance, fmtDateTime } from '@/lib/formatters';
import { fetchAdminList } from '@/server/admin-list';
import { ListPage } from '@/components/list-page';
import { parseListSearchParams } from '@/lib/list-query';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function RateCardDetailPage({ params, searchParams }: PageProps) {
  await requirePermission('catalog:read');
  const { id } = await params;
  const t = await getTranslations('rateCards');
  const tc = await getTranslations('common');
  const tu = await getTranslations('users');
  const rcId = Number(id);
  if (!Number.isFinite(rcId) || rcId <= 0) notFound();

  let card: AdminRateCardRow | null = null;
  let error: string | null = null;
  try {
    // 后端没有单条 GET /:id，从列表里找
    const list = await fetchAdminList<AdminRateCardRow>('/v1/rate-cards', { pageSize: 100 });
    card = list.rows.find((c) => c.id === rcId) ?? null;
    if (!card) notFound();
  } catch (e) {
    error = e instanceof ApiError ? e.message : tc('loadFailed');
  }

  const sp = await searchParams;
  const { q, page, sortBy, order } = parseListSearchParams(sp);
  const {
    rows: users,
    total,
    error: usersError,
  } = await fetchAdminList<AdminUserRow>(`/v1/rate-cards/${rcId}/users`, {
    page,
    pageSize: PAGE_SIZE,
    sortBy,
    order,
    extra: { q },
  });

  if (!card) {
    return (
      <div className="flex flex-col gap-4">
        <Button
          variant="ghost"
          size="sm"
          className="w-fit"
          render={
            <Link href="/dashboard/rate-cards">
              <ArrowLeftIcon /> {t('back')}
            </Link>
          }
        />
        <Card>
          <CardContent className="p-6 text-sm text-destructive">
            {error ?? t('notFound')}
          </CardContent>
        </Card>
      </div>
    );
  }

  const columns: DataTableColumn<AdminUserRow>[] = [
    {
      key: 'id',
      header: 'ID',
      sortable: true,
      headerClassName: 'w-16',
      render: (u) => <span className="text-xs text-muted-foreground tabular-nums">#{u.id}</span>,
    },
    {
      key: 'subject',
      header: tc('account'),
      sortable: true,
      render: (u) => <span className="font-medium">{u.subject}</span>,
    },
    {
      key: 'displayName',
      header: tc('displayName'),
      render: (u) => <span className="text-muted-foreground">{u.displayName ?? '—'}</span>,
    },
    {
      key: 'email',
      header: tc('email'),
      render: (u) => <span className="text-xs text-muted-foreground">{u.email ?? '—'}</span>,
    },
    {
      key: 'balance',
      header: tu('settledBalance'),
      sortable: true,
      align: 'right',
      render: (u) => <span className="text-right tabular-nums">{fmtBalance(u.balance)}</span>,
    },
    {
      key: 'reservedBalance',
      header: tu('reservedBalance'),
      align: 'right',
      render: (u) => (
        <span className="text-right tabular-nums text-amber-600">
          {fmtBalance(u.reservedBalance)}
        </span>
      ),
    },
    {
      key: 'availableBalance',
      header: tu('availableBalance'),
      align: 'right',
      render: (u) => (
        <span className="text-right tabular-nums">{fmtBalance(u.availableBalance)}</span>
      ),
    },
    {
      key: 'lastLoginAt',
      header: tc('lastLogin'),
      headerClassName: 'w-44',
      render: (u) => (
        <span className="text-xs text-muted-foreground">
          {u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : tc('never')}
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Button
        variant="ghost"
        size="sm"
        className="w-fit"
        render={
          <Link href="/dashboard/rate-cards">
            <ArrowLeftIcon /> {t('back')}
          </Link>
        }
      />

      <ListPage
        title={`${card.name} ×${card.coefficient}`}
        description={t('detailDescription', {
          desc: card.description ?? t('noDescription'),
          status: card.status === 0 ? tc('enabled') : tc('disabled'),
          time: fmtDateTime(card.updatedAt),
        })}
        total={total}
        totalUnit={t('boundUsersUnit')}
        searchPlaceholder={t('searchUsersPlaceholder')}
        q={q}
        searchParams={{ q, sort_by: sortBy, order: sortBy ? order : undefined }}
        error={usersError ?? error}
        page={page}
        pageSize={PAGE_SIZE}
      >
        <DataTable
          columns={columns}
          rows={users}
          rowKey={(u) => u.id}
          sort={{ sortBy, order }}
          searchParams={{ q }}
          empty={t('noBoundUsers')}
        />
      </ListPage>
    </div>
  );
}
