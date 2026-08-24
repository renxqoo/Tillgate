import { requirePermission } from '@/server/get-admin';
import { CalendarClockIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { fetchAdminList } from '@/server/admin-list';
import type { AdminSubscriptionRow, PlanRow as ApiPlanRow } from '@tillgate/api-client';
import { ListPage } from '@/components/list-page';
import { firstParam, parseListSearchParams } from '@/lib/list-query';

import { SubscriptionsTable } from '@/features/billing/subscriptions-content';
import { SubscriptionsStatusFilter } from '@/features/billing/subscriptions-status-filter';
import type { PlanOption } from '@/features/billing/subscriptions-content';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SubscriptionsPage({ searchParams }: PageProps) {
  await requirePermission('plans:read');
  const sp = await searchParams;
  const t = await getTranslations('subscriptions');
  const { q, page, sortBy, order } = parseListSearchParams(sp);
  const planIdRaw = firstParam(sp.planId);
  const planId = planIdRaw ? Number(planIdRaw) : undefined;
  const userId = (firstParam(sp.userId) ?? '').trim();
  const status = firstParam(sp.status) ?? 'all';
  const { rows, total, error } = await fetchAdminList<AdminSubscriptionRow>('/v1/subscriptions', {
    page,
    pageSize: PAGE_SIZE,
    sortBy,
    order,
    extra: {
      q,
      planId: planId ? String(planId) : undefined,
      userId: userId || undefined,
      status: status === '0' || status === '1' || status === '2' ? status : undefined,
    },
  });

  // 变更弹窗需要套餐列表（按 planId 找当前层级、筛选可升目标）
  let plans: PlanOption[] = [];
  try {
    const data = await fetchAdminList<ApiPlanRow>('/v1/plans', { page: 1, pageSize: 100 });
    plans = data.rows.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      sortOrder: p.sortOrder,
    }));
  } catch {
    // 套餐列表加载失败不阻断订阅列表，变更弹窗将仅支持同套餐加席位
  }

  return (
    <ListPage
      title={t('title')}
      icon={<CalendarClockIcon className="size-5 text-muted-foreground" />}
      total={total}
      totalUnit={t('totalUnit')}
      searchPlaceholder={t('searchPlaceholder')}
      q={q}
      searchParams={{
        q,
        planId: planIdRaw,
        userId: userId || undefined,
        status: status !== 'all' ? status : undefined,
        sort_by: sortBy,
        order: sortBy ? order : undefined,
      }}
      filters={<SubscriptionsStatusFilter value={status} />}
      error={error}
      page={page}
      pageSize={PAGE_SIZE}
    >
      <SubscriptionsTable rows={rows} plans={plans} />
    </ListPage>
  );
}
