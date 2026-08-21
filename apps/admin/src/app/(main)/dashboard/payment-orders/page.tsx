import { CreditCard } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { fmtDateTime } from '@ai-gateway/api-client/formatters';
import { fetchAdminList } from '@ai-gateway/api-client/list';
import { DataTable, type DataTableColumn } from '@ai-gateway/ui/components/data-table';
import { ListPage } from '@ai-gateway/ui/components/list-page';
import { StatusPill } from '@ai-gateway/ui/components/status-pill';

import { CloseOrderActions } from './_components/close-order-actions';

export const dynamic = 'force-dynamic';

interface PaymentOrderRow {
  id: string;
  provider: string;
  providerOrderId: string;
  userId: number;
  userDisplayName: string | null;
  userSubject: string | null;
  amount: string;
  creditAmount: string;
  currency: string;
  status: number;
  failureReason: string | null;
  createdAt: string;
  paidAt: string | null;
  creditedAt: string | null;
}

// 状态 tone 映射留模块级；label 是 paymentOrders 命名空间的 i18n key，渲染处用 t 解析
const STATUS: Record<number, { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  0: { label: 'statusPending', tone: 'warning' },
  1: { label: 'statusPaid', tone: 'warning' },
  2: { label: 'statusCredited', tone: 'success' },
  3: { label: 'statusRefunded', tone: 'neutral' },
  4: { label: 'statusClosed', tone: 'neutral' },
};

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PaymentOrdersPage({ searchParams }: PageProps) {
  const t = await getTranslations('paymentOrders');
  const tc = await getTranslations('common');
  const sp = await searchParams;
  const q = typeof sp.q === 'string' ? sp.q : undefined;
  const { rows, error } = await fetchAdminList<PaymentOrderRow>('/v1/payment-orders', {
    pageSize: 20,
    extra: q ? { q } : undefined,
  });

  const columns: DataTableColumn<PaymentOrderRow>[] = [
    { key: 'createdAt', header: tc('createdAt'), render: (r) => fmtDateTime(r.createdAt) },
    {
      key: 'user',
      header: tc('user'),
      render: (r) => r.userDisplayName ?? r.userSubject ?? `#${r.userId}`,
    },
    { key: 'provider', header: t('provider'), render: (r) => (r.provider === 'stripe' ? 'Stripe' : t('onlinePayment')) },
    { key: 'amount', header: t('paidAmount'), align: 'right', render: (r) => `¥${r.amount}` },
    { key: 'creditAmount', header: t('creditedAmount'), align: 'right', render: (r) => `¥${r.creditAmount}` },
    {
      key: 'status',
      header: tc('status'),
      render: (r) => {
        const s = STATUS[r.status] ?? { label: String(r.status), tone: 'neutral' as const };
        return <StatusPill tone={s.tone}>{STATUS[r.status] ? t(s.label) : t('unknownStatus', { status: s.label })}</StatusPill>;
      },
    },
    {
      key: 'actions',
      header: tc('actions'),
      render: (r) => (r.status === 0 ? <CloseOrderActions orderId={r.id} /> : null),
    },
  ];

  return (
    <ListPage
      title={t('title')}
      description={t('description')}
      icon={<CreditCard className="size-5 text-muted-foreground" />}
    >
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <DataTable rowKey={(r) => r.id} rows={rows} columns={columns} empty={t('noOrders')} />
    </ListPage>
  );
}
