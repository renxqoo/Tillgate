import { requirePermission } from '@/server/get-admin';
import { RouteIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { adminApi } from '@/server/admin-api';
import { PageHeader } from '@tillgate/ui';
import type { RoutingPolicyDefaults, RoutingPolicyRecord } from '@tillgate/api-client';
import { RoutingClient } from '@/features/routing/routing-content';
import { ChannelOverviewTable } from '@/features/routing/overview-table';
import { resolveOverviewSort, sortOverviewRows } from '@/features/routing/overview-sort';
import { formOf } from '@/features/routing/routing-policy-form';
import type {
  BudgetWatermarkHint,
  ChannelOverviewView,
} from '@/features/routing/routing-content-types';
import { firstParam } from '@/lib/list-query';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** 智能路由管理：策略热配置（网关按 TTL 拾取生效，不重启）+ 渠道观测（调参闭环）。权限：catalog 域（读写码经 endpoint_permissions 绑定）。 */
export default async function RoutingPage({ searchParams }: PageProps) {
  await requirePermission('catalog:read');
  const t = await getTranslations('routing');
  const api = adminApi();
  // 观测窗口/排序全走 URL（GET 可分享）：window 仅认 24h，其余（含缺省）= 1h
  const sp = await searchParams;
  const windowHours: 1 | 24 = firstParam(sp.window) === '24h' ? 24 : 1;
  const sort = resolveOverviewSort(firstParam(sp.sort_by), firstParam(sp.order));

  const [policyRes, overviewRes] = await Promise.allSettled([
    api.get<RoutingPolicyRecord | RoutingPolicyDefaults>('/v1/routing-policy'),
    api.get<{ rows: ChannelOverviewView[] }>(
      `/v1/routing/channels-overview?windowMs=${windowHours * 3_600_000}`,
    ),
  ]);

  const payload = policyRes.status === 'fulfilled' ? policyRes.value : null;
  const current =
    payload != null && 'version' in payload
      ? {
          version: payload.version,
          policy: payload.policy,
          updatedAt: payload.updatedAt,
          updatedBy: payload.updatedBy,
        }
      : null;
  // 未配置时用编译期缺省做表单初值（API 携带——前端不依赖 inference 运行时）
  const fallback: Record<string, unknown> =
    payload != null && 'policy' in payload && payload.policy != null ? payload.policy : {};
  // 预算降权阈值快照（观测表预算列高亮）：formOf 防御解析，两个分支的 policy 都带
  // budgetWatermark 段（已配置 = 库值；未配置 = 编译期缺省），无需再兜底
  const policyForm = formOf(payload?.policy);
  const watermark: BudgetWatermarkHint = {
    enabled: policyForm.budgetWatermarkEnabled,
    softRatio: Number(policyForm.softRatio),
  };
  const rows = sortOverviewRows(
    overviewRes.status === 'fulfilled' ? overviewRes.value.rows : [],
    sort,
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('title')}
        description={t('description')}
        icon={<RouteIcon className="h-5 w-5" />}
      />
      <RoutingClient current={current} fallback={fallback} />
      <ChannelOverviewTable
        rows={rows}
        t={t}
        searchParams={sp}
        sort={sort}
        windowHours={windowHours}
        watermark={watermark}
      />
    </div>
  );
}
