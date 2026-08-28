import { requirePermission, hasPerm } from '@/server/get-admin';
import type { AdminChannelRow } from '@tillgate/api-client';
import { fetchAdminList } from '@/server/admin-list';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@tillgate/ui';
import { getTranslations } from 'next-intl/server';

import type { AdminChannelFundRow, ChannelOption } from '@tillgate/api-client';
import { ChannelFundsClient } from '@/features/billing/channel-funds-content';
import { CurrencyCard } from '@/features/billing/currency-card';
import { FxCard } from '@/features/billing/fx-card';
import { BillingTimezoneCard } from '@/features/funds/billing-timezone-card';
import { DebitFloorCard } from '@/features/funds/debit-floor-card';
import { ReservationPolicyCard } from '@/features/funds/reservation-policy-card';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

/**
 * 资金中心（docs/funds-center/DESIGN.md）：资金管理单入口三页签——
 * 渠道资金（原 channel-funds 页整体并入）/ 风控参数（自设置页迁入的三张卡）/
 * 汇率（消费 control-plane fx 既有用例）。卡片自治：各自带 server actions 与权限。
 */
export default async function FundsPage() {
  const me = await requirePermission('funds:read');
  const t = await getTranslations('funds');
  // 权限随卡片原语义：地板/预扣 = funds:floor；时区 = settings:update（搬家不改授权面）
  const canManageRisk = me != null && hasPerm(me, 'funds:floor');
  const canUpdateTimezone = me != null && hasPerm(me, 'settings:update');
  const canManageFx = me != null && hasPerm(me, 'funds:fx');

  const channelsRes = await fetchAdminList<AdminChannelRow>('/v1/channels', { pageSize: 100 }).catch(
    () => null,
  );
  const channels: ChannelOption[] = (channelsRes?.rows ?? []).map((x) => ({ id: x.id, name: x.name }));
  const fundsRes = await fetchAdminList<AdminChannelFundRow>('/v1/channel-funds', {
    page: 1,
    pageSize: PAGE_SIZE,
  });

  return (
    <div className="flex w-full flex-col gap-4">
      <Tabs defaultValue="channels" className="w-full">
        <TabsList>
          <TabsTrigger value="channels">{t('tabChannels')}</TabsTrigger>
          <TabsTrigger value="risk">{t('tabRisk')}</TabsTrigger>
          <TabsTrigger value="fx">{t('tabFx')}</TabsTrigger>
        </TabsList>

        <TabsContent value="channels" className="mt-2">
          <ChannelFundsClient
            rows={fundsRes.rows}
            channels={channels}
            total={fundsRes.total}
            initialChannelId={undefined}
            initialType={undefined}
          />
        </TabsContent>

        <TabsContent value="risk" className="mt-2 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <DebitFloorCard canUpdate={canManageRisk} />
          <ReservationPolicyCard canUpdate={canManageRisk} />
          <BillingTimezoneCard canUpdate={canUpdateTimezone} />
        </TabsContent>

        <TabsContent value="fx" className="mt-2 grid grid-cols-1 gap-4 md:grid-cols-2">
          <FxCard canManage={canManageFx} />
          <CurrencyCard canManage={canManageRisk} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
