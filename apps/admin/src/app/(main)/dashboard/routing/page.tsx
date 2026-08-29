import { requirePermission } from '@/server/get-admin';
import { RouteIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { adminApi } from '@/server/admin-api';
import { PageHeader } from '@tillgate/ui';
import type { RoutingPolicyDefaults, RoutingPolicyRecord } from '@tillgate/api-client';
import { RoutingClient } from '@/features/routing/routing-content';
import type { ChannelOverviewView } from '@/features/routing/routing-content-types';

export const dynamic = 'force-dynamic';

/** 智能路由管理：策略热配置（网关按 TTL 拾取生效，不重启）+ 渠道观测（调参闭环）。权限：catalog 域（读写码经 endpoint_permissions 绑定）。 */
export default async function RoutingPage() {
  await requirePermission('catalog:read');
  const t = await getTranslations('routing');
  const api = adminApi();

  const [policyRes, overviewRes] = await Promise.allSettled([
    api.get<RoutingPolicyRecord | RoutingPolicyDefaults>('/v1/routing-policy'),
    api.get<{ rows: ChannelOverviewView[] }>('/v1/routing/channels-overview?windowMs=3600000'),
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
  const overview = overviewRes.status === 'fulfilled' ? overviewRes.value.rows : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('title')}
        description={t('description')}
        icon={<RouteIcon className="h-5 w-5" />}
      />
      <RoutingClient current={current} fallback={fallback} overview={overview} />
    </div>
  );
}
