import { WalletIcon } from 'lucide-react';

import { apiFetch } from '@ai-gateway/api-client';
import { fmtDateTime, formatMoney } from '@ai-gateway/api-client/formatters';
import { DataTable, type DataTableColumn } from '@ai-gateway/ui/components/data-table';
import { Card, CardContent } from '@ai-gateway/ui/components/ui/card';
import { ListPage } from '@ai-gateway/ui/components/list-page';
import { StatusPill } from '@ai-gateway/ui/components/status-pill';
import { getTranslations } from 'next-intl/server';

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

/** 支付单状态：tone 固定，label 由目录解析（billing.statusXxx） */
const STATUS_KEYS: Record<number, string> = {
  0: 'statusPending',
  1: 'statusPaid',
  2: 'statusCredited',
  3: 'statusRefunded',
  4: 'statusClosed',
};

const STATUS_TONE: Record<number, 'success' | 'warning' | 'neutral'> = {
  0: 'warning',
  1: 'warning',
  2: 'success',
  3: 'neutral',
  4: 'neutral',
};

export default async function BillingPage() {
  const t = await getTranslations('billing');
  const tCommon = await getTranslations('common');
  // v2：订单列表 /v1/payments/orders + 已启用渠道 /v1/payments/channels（渠道端点失败则空——表单自显充值码提示）
  const [ordersData, channelsData] = await Promise.all([
    apiFetch<{ rows?: PaymentOrderRow[] }>('/v1/payments/orders?page=1&limit=20').catch(() => null),
    apiFetch<{ channels?: Array<{ id: 'epay' | 'stripe'; label: string }> }>('/v1/payments/channels').catch(
      () => null,
    ),
  ]);
  const orderRows = ordersData?.rows ?? [];
  const data: ChannelsResponse | null = {
    channels: channelsData?.channels ?? [],
    orders: orderRows,
  };

  const columns: DataTableColumn<PaymentOrderRow>[] = [
    { key: 'createdAt', header: tCommon('time'), render: (r) => fmtDateTime(r.createdAt) },
    {
      key: 'provider',
      header: tCommon('channel'),
      render: (r) => (r.provider === 'epay' ? t('onlinePay') : r.provider === 'stripe' ? 'Stripe' : r.provider),
    },
    { key: 'amount', header: tCommon('amount'), align: 'right', render: (r) => `¥${formatMoney(r.amount)}` },
    {
      key: 'status',
      header: tCommon('status'),
      render: (r) => {
        const key = STATUS_KEYS[r.status];
        const label = key ? t(key) : t('statusUnknown', { status: r.status });
        return <StatusPill tone={STATUS_TONE[r.status] ?? 'neutral'}>{label}</StatusPill>;
      },
    },
  ];

  return (
    <ListPage
      title={t('title')}
      description={t('description')}
      icon={<WalletIcon className="size-5 text-muted-foreground" />}
      unbordered
    >
      <div className="space-y-6">
        <TopUpForm channels={data?.channels ?? []} />
        <Card>
          <CardContent>
            <DataTable rowKey={(r) => r.id} rows={data?.orders ?? []} columns={columns} empty={t('emptyOrders')} />
          </CardContent>
        </Card>
      </div>
    </ListPage>
  );
}
