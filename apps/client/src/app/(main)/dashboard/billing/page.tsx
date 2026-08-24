import { WalletIcon } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import type {
  PaymentOrdersPage,
  PaymentOrderRow,
  PaymentChannelsResult,
} from '@tokenlens/api-client';
import { Card, CardContent, DataTable, StatusPill, type DataTableColumn } from '@tokenlens/ui';

import { formatDateTime, formatMoney } from '@/features/shared/format';
import { ListPage } from '@/features/shared/list-page';
import { ORDER_STATUS_KEYS, ORDER_STATUS_TONES } from '@/features/wallet/order-status';
import { TopUpForm } from '@/features/wallet/topup-form';
import { createClientApi } from '@/server/api';
import { requireMe } from '@/server/session';

export const dynamic = 'force-dynamic';

const ORDERS_PAGE_SIZE = 20;

export default async function BillingPage() {
  const t = await getTranslations('billing');
  const tCommon = await getTranslations('common');
  const locale = await getLocale();
  const api = createClientApi();
  await requireMe(api);
  // 订单列表（信封只 rows 无 total——G3：去页码条，按「最近 20 笔」展示）+ 渠道目录
  // （渠道端点失败则空——表单自显充值码提示）
  const [ordersData, channelsData] = await Promise.all([
    api
      .get<PaymentOrdersPage>(`/v1/payments/orders?page=1&limit=${ORDERS_PAGE_SIZE}`)
      .catch(() => null),
    api.get<PaymentChannelsResult>('/v1/payments/channels').catch(() => null),
  ]);
  const orders: PaymentOrderRow[] = ordersData?.rows ?? [];
  const channels = channelsData?.channels ?? [];

  const columns: DataTableColumn<PaymentOrderRow>[] = [
    {
      key: 'createdAt',
      header: tCommon('time'),
      cell: (r) => (
        <span className="text-xs text-muted-foreground">{formatDateTime(r.createdAt, locale)}</span>
      ),
    },
    {
      key: 'provider',
      header: tCommon('channel'),
      cell: (r) => {
        if (r.provider === 'epay') return t('onlinePay');
        if (r.provider === 'stripe') return 'Stripe';
        return r.provider;
      },
    },
    {
      key: 'amount',
      header: tCommon('amount'),
      align: 'right',
      cell: (r) => <span className="text-right tabular-nums">{formatMoney(r.amount, locale)}</span>,
    },
    {
      key: 'status',
      header: tCommon('status'),
      cell: (r) => {
        const key = ORDER_STATUS_KEYS[r.status];
        const label = key ? t(key) : t('statusUnknown', { status: r.status });
        return <StatusPill tone={ORDER_STATUS_TONES[r.status] ?? 'neutral'}>{label}</StatusPill>;
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
        <TopUpForm channels={channels} />
        <Card>
          <CardContent>
            <DataTable
              rowKey={(r) => r.id}
              rows={orders}
              columns={columns}
              empty={t('emptyOrders')}
            />
          </CardContent>
        </Card>
      </div>
    </ListPage>
  );
}
