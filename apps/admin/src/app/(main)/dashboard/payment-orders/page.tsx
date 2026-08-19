import { CreditCard } from 'lucide-react';

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

const STATUS: Record<number, { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  0: { label: '待支付', tone: 'warning' },
  1: { label: '已支付', tone: 'warning' },
  2: { label: '已到账', tone: 'success' },
  3: { label: '已退款', tone: 'neutral' },
  4: { label: '已关闭', tone: 'neutral' },
};

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PaymentOrdersPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const q = typeof sp.q === 'string' ? sp.q : undefined;
  const { rows, error } = await fetchAdminList<PaymentOrderRow>('/api/admin/payment-orders', {
    pageSize: 20,
    extra: q ? { q } : undefined,
  });

  const columns: DataTableColumn<PaymentOrderRow>[] = [
    { key: 'createdAt', header: '创建时间', render: (r) => fmtDateTime(r.createdAt) },
    {
      key: 'user',
      header: '用户',
      render: (r) => r.userDisplayName ?? r.userSubject ?? `#${r.userId}`,
    },
    { key: 'provider', header: '渠道', render: (r) => (r.provider === 'stripe' ? 'Stripe' : '在线支付') },
    { key: 'amount', header: '实付', align: 'right', render: (r) => `¥${r.amount}` },
    { key: 'creditAmount', header: '到账', align: 'right', render: (r) => `¥${r.creditAmount}` },
    {
      key: 'status',
      header: '状态',
      render: (r) => {
        const s = STATUS[r.status] ?? { label: `状态 ${r.status}`, tone: 'neutral' as const };
        return <StatusPill tone={s.tone}>{s.label}</StatusPill>;
      },
    },
    {
      key: 'actions',
      header: '操作',
      render: (r) => (r.status === 0 ? <CloseOrderActions orderId={r.id} /> : null),
    },
  ];

  return (
    <ListPage
      title="支付订单"
      description="在线支付订单与入账状态（入账由渠道回调自动完成）"
      icon={<CreditCard className="size-5 text-muted-foreground" />}
    >
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <DataTable rowKey={(r) => r.id} rows={rows} columns={columns} empty="暂无支付订单" />
    </ListPage>
  );
}
