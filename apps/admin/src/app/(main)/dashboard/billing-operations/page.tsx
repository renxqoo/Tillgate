import { requirePermission } from '@/server/get-admin';
import { DataTable } from '@/components/data-table';
import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { fmtDateTime, formatMoney } from '@/lib/formatters';
import { fetchAdminList } from '@/server/admin-list';
import { ListPage } from '@/components/list-page';
import { parseListSearchParams } from '@/lib/list-query';
import { ReviewActions } from '@/features/billing/review-actions';

export const dynamic = 'force-dynamic';

interface BillingCase {
  requestId: string;
  userId: number;
  status: 'dead';
  revision: number;
  reservedAmount: string;
  failureCode: string | null;
  failureClass: string | null;
  lastError: string | null;
  updatedAt: string;
}

const PAGE_SIZE = 20;

export default async function BillingOperationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission('funds:read');
  const sp = await searchParams;
  const t = await getTranslations('billingOperations');
  const tc = await getTranslations('common');
  const { page } = parseListSearchParams(sp);
  const status = 'dead' as const; // uncertain 队列已随 2026-08-17 估算结算政策删除
  const {
    rows: items,
    total,
    error,
  } = await fetchAdminList<BillingCase>('/v1/billing-operations', {
    page,
    pageSize: PAGE_SIZE,
    extra: { status },
  });

  return (
    <ListPage
      title={t('title')}
      icon={<ShieldAlert className="size-5 text-muted-foreground" />}
      description={t('description')}
      total={total}
      searchParams={{ status }}
      error={error}
      page={page}
      pageSize={PAGE_SIZE}
    >
      <DataTable
        columns={[
          {
            key: 'requestId',
            header: t('requestId'),
            render: (item: BillingCase) => (
              <span>
                <code className="text-xs">{item.requestId}</code>{' '}
                <Link
                  href={`/dashboard/tracing?requestId=${item.requestId}`}
                  className="text-xs underline"
                >
                  {t('viewTrace')}
                </Link>
              </span>
            ),
          },
          { key: 'userId', header: tc('user'), render: (item: BillingCase) => `#${item.userId}` },
          {
            key: 'reservedAmount',
            header: t('reserved'),
            align: 'right',
            render: (item: BillingCase) => `¥${formatMoney(item.reservedAmount)}`,
          },
          {
            key: 'failureClass',
            header: t('reason'),
            render: (item: BillingCase) => (
              <span className="max-w-64 text-xs">
                {item.failureClass ?? item.failureCode ?? item.lastError ?? '—'}
              </span>
            ),
          },
          {
            key: 'updatedAt',
            header: tc('updatedAt'),
            render: (item: BillingCase) => fmtDateTime(item.updatedAt),
          },
          {
            key: 'actions',
            header: tc('actions'),
            render: (item: BillingCase) => (
              <ReviewActions
                requestId={item.requestId}
                revision={item.revision}
                status={item.status}
              />
            ),
          },
        ]}
        rows={items}
        rowKey={(item: BillingCase) => item.requestId}
        empty={t('noCases')}
      />
    </ListPage>
  );
}
