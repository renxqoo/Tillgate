import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeftIcon } from 'lucide-react';

import {
  ApiError,
  fmtBalance,
  fmtDateTime,
  type AdminRateCardRow,
  type AdminUserRow,
} from '@ai-gateway/api-client';
import { fetchAdminList } from '@ai-gateway/api-client/list';
import { Button } from '@ai-gateway/ui/components/ui/button';
import { Card, CardContent } from '@ai-gateway/ui/components/ui/card';
import { DataTable, type DataTableColumn } from '@ai-gateway/ui/components/data-table';
import { ListPage } from '@ai-gateway/ui/components/list-page';
import { parseListSearchParams } from "@ai-gateway/ui/lib/list-query";

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function RateCardDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const rcId = Number(id);
  if (!Number.isFinite(rcId) || rcId <= 0) notFound();

  let card: AdminRateCardRow | null = null;
  let error: string | null = null;
  try {
    // 后端没有单条 GET /:id，从列表里找
    const list = await fetchAdminList<AdminRateCardRow>('/api/admin/rate-cards', { pageSize: 100 });
    card = list.rows.find((c) => c.id === rcId) ?? null;
    if (!card) notFound();
  } catch (e) {
    error = e instanceof ApiError ? e.message : '加载失败';
  }

  const sp = await searchParams;
  const { q, page, sortBy, order } = parseListSearchParams(sp);
  const { rows: users, total, error: usersError } = await fetchAdminList<AdminUserRow>(
    `/api/admin/rate-cards/${rcId}/users`,
    { page, pageSize: PAGE_SIZE, sortBy, order, extra: { q } },
  );

  if (!card) {
    return (
      <div className="flex flex-col gap-4">
        <Button asChild variant="ghost" size="sm" className="w-fit">
          <Link href="/dashboard/rate-cards">
            <ArrowLeftIcon /> 返回费率卡
          </Link>
        </Button>
        <Card>
          <CardContent className="p-6 text-sm text-destructive">
            {error ?? '费率卡不存在'}
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
    { key: 'subject', header: '账号', sortable: true, render: (u) => <span className="font-medium">{u.subject}</span> },
    { key: 'displayName', header: '显示名', render: (u) => <span className="text-muted-foreground">{u.displayName ?? '—'}</span> },
    { key: 'email', header: '邮箱', render: (u) => <span className="text-xs text-muted-foreground">{u.email ?? '—'}</span> },
    { key: 'balance', header: '已结算', sortable: true, align: 'right', render: (u) => <span className="text-right tabular-nums">{fmtBalance(u.balance)}</span> },
    { key: 'reservedBalance', header: '处理中预留', align: 'right', render: (u) => <span className="text-right tabular-nums text-amber-600">{fmtBalance(u.reservedBalance)}</span> },
    { key: 'availableBalance', header: '可用额度', align: 'right', render: (u) => <span className="text-right tabular-nums">{fmtBalance(u.availableBalance)}</span> },
    { key: 'lastLoginAt', header: '最近登录', headerClassName: 'w-44', render: (u) => <span className="text-xs text-muted-foreground">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : '从未'}</span> },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Button asChild variant="ghost" size="sm" className="w-fit">
        <Link href="/dashboard/rate-cards">
          <ArrowLeftIcon /> 返回费率卡
        </Link>
      </Button>

      <ListPage
        title={`${card.name} ×${card.coefficient}`}
        description={`${card.description ?? '无说明'} · 状态 ${card.status === 0 ? '启用' : '禁用'} · 更新于 ${fmtDateTime(card.updatedAt)}`}
        total={total}
        totalUnit="个绑定用户"
        searchPlaceholder="搜索 subject / 显示名 / 邮箱"
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
          empty="暂无绑定用户"
        />
      </ListPage>
    </div>
  );
}
