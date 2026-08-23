import { GemIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import {
  ApiError,
  type CurrentSubscription,
  type OrgRow,
  type PlanRow,
  type RowsPage,
  type RowsTotalPage,
} from '@tokenlens/api-client';
import { StatusPill } from '@tokenlens/ui';

import { SubscriptionContent } from '@/features/subscription/subscription-content';
import { createClientApi } from '@/server/api';
import { fetchPlans } from '@/server/plans';
import { requireMe } from '@/server/session';

export const dynamic = 'force-dynamic';

export default async function SubscriptionPage() {
  const t = await getTranslations('subscription');
  const api = createClientApi();
  let subscription: CurrentSubscription | null = null;
  let plans: PlanRow[] = [];
  let orgs: OrgRow[] = [];
  let subError: string | null = null;
  let plansError: string | null = null;
  // 布局已 requireMe；本页再守卫一次并直接取 isEnterprise（B10：去掉 v1 的重复 /v1/me 拉取）
  const me = await requireMe(api);
  const isEnterprise = me.isEnterprise === true;

  try {
    const subResult = await api.get<RowsPage<CurrentSubscription>>('/v1/subscriptions');
    subscription = subResult.rows[0] ?? null;
  } catch (e) {
    subError = e instanceof ApiError ? e.message : t('loadFailed');
  }

  // B2 修复在 server/plans.ts 单点：limit=100（v1 page_size 形态被忽略截断）
  const plansResult = await fetchPlans(api, isEnterprise, t('loadFailed'));
  plans = plansResult.plans;
  plansError = plansResult.error;

  try {
    const data = await api.get<RowsTotalPage<OrgRow>>('/v1/orgs');
    // 只展示有有效套餐的组织；无套餐组织在 /dashboard/orgs 管理，不在此展示。
    orgs = (data.rows ?? []).filter((o) => o.subscriptionId != null);
  } catch {
    orgs = [];
  }

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <GemIcon className="size-5 text-muted-foreground" />
          {t('title')}
          {isEnterprise ? <StatusPill tone="info">{t('enterpriseBadge')}</StatusPill> : null}
        </h1>
        <p className="text-sm text-muted-foreground">
          {isEnterprise ? t('descEnterprise') : t('descPersonal')}
        </p>
      </div>

      <SubscriptionContent
        subscription={subscription}
        plans={plans}
        subError={subError}
        plansError={plansError}
        orgs={orgs}
      />
    </div>
  );
}
