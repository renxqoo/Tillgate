import { WalletIcon } from 'lucide-react';

import { apiFetch } from '@ai-gateway/api-client';
import { formatMoney } from '@ai-gateway/api-client/formatters';
import { DataTable, type DataTableColumn } from '@ai-gateway/ui/components/data-table';
import { Card, CardContent } from '@ai-gateway/ui/components/ui/card';
import { ListPage } from '@ai-gateway/ui/components/list-page';
import { StatusPill } from '@ai-gateway/ui/components/status-pill';

import { TopUpForm } from './_components/topup-form';

export const dynamic = 'force-dynamic';

interface PaymentOrderRow {
  id: string;
  provider: string;
  amount: string;
  creditAmount: string;
  currency: string;
  status: number;
  createdAt: string;
  paidAt: string | null;
  creditedAt: string | null;
  failureReason: string | null;
}

interface ChannelsResponse {
  channels: Array<{ id: 'epay' | 'stripe'; label: string }>;
  orders: PaymentOrderRow[];
}

const STATUS: Record<number, { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  0: { label: '待支付', tone: 'warning' },
  1: { label: '已支付', tone: 'warning' },
  2: { label: '已到账', tone: 'success' },
  3: { label: '已退款', tone: 'neutral' },
  4: { label: '已关闭', tone: 'neutral' },
};

export default async function BillingPage() {
  const data = await apiFetch<ChannelsResponse>('/api/payments').catch(() => null);

  const columns: DataTableColumn<PaymentOrderRow>[] = [
    { key: 'createdAt', header: '时间', render: (r) => new Date(r.createdAt).toLocaleString('zh-CN') },
    {
      key: 'provider',
      header: '渠道',
      render: (r) => (r.provider === 'epay' ? '在线支付' : r.provider === 'stripe' ? 'Stripe' : r.provider),
    },
    { key: 'amount', header: '金额', align: 'right', render: (r) => `¥${formatMoney(r.amount)}` },
    {
      key: 'status',
      header: '状态',
      render: (r) => {
        const s = STATUS[r.status] ?? { label: `状态 ${r.status}`, tone: 'neutral' as const };
        return <StatusPill tone={s.tone}>{s.label}</StatusPill>;
      },
    },
  ];

  return (
    <ListPage
      title="充值与账单"
      description="在线充值、支付订单与充值历史"
      icon={<WalletIcon className="size-5 text-muted-foreground" />}
    >
      <div className="space-y-6">
        <TopUpForm channels={data?.channels ?? []} />
        <Card>
          <CardContent>
            <DataTable rowKey={(r) => r.id} rows={data?.orders ?? []} columns={columns} empty="暂无支付订单" />
          </CardContent>
        </Card>
      </div>
    </ListPage>
  );
}
