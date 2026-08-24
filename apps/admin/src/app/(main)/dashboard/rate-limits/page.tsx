import { requirePermission } from '@/server/get-admin';
import { GaugeIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import type {
  AdminChannelRow,
  AdminKeyRow,
  AdminModelRow,
  AdminUserRow,
} from '@tillgate/api-client';
import { fetchAdminList } from '@/server/admin-list';
import { ListPage } from '@/components/list-page';
import { firstParam } from '@/lib/list-query';

import { RateLimitsClient } from '@/features/channels/rate-limits-content';
import type { RateLimitItem } from '@/features/channels/rate-limit-types';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function RateLimitsPage({ searchParams }: PageProps) {
  await requirePermission('users:read');
  const sp = await searchParams;
  const t = await getTranslations('rateLimits');
  const tc = await getTranslations('common');
  const q = firstParam(sp.q) ?? '';
  // 并发拉取 4 类实体（统一分页接口 + q 搜索）；任一失败不阻塞整页
  const [usersRes, modelsRes, channelsRes, keysRes] = await Promise.allSettled([
    fetchAdminList<AdminUserRow>('/v1/users', { pageSize: 100, extra: { q } }),
    fetchAdminList<AdminModelRow>('/v1/models', { pageSize: 100, extra: { q } }),
    fetchAdminList<AdminChannelRow>('/v1/channels', { pageSize: 100, extra: { q } }),
    fetchAdminList<AdminKeyRow>('/v1/admin-keys', { pageSize: 100, extra: { q } }),
  ]);

  const users: RateLimitItem[] =
    usersRes.status === 'fulfilled'
      ? usersRes.value.rows.map((u) => ({
          id: u.id,
          label: u.email ?? t('userLabel', { id: u.id }),
          sublabel: u.displayName,
          rpmLimit: u.rpmLimit,
          tpmLimit: u.tpmLimit,
          creditLimit: u.creditLimit,
          dailySpendLimit: u.dailySpendLimit,
          status: u.status,
        }))
      : [];
  const models: RateLimitItem[] =
    modelsRes.status === 'fulfilled'
      ? modelsRes.value.rows.map((m) => ({
          id: m.id,
          label: m.externalName,
          sublabel: m.realModel,
          rpmLimit: m.rpmLimit,
          tpmLimit: m.tpmLimit,
          status: m.status,
        }))
      : [];
  const channels: RateLimitItem[] =
    channelsRes.status === 'fulfilled'
      ? channelsRes.value.rows.map((c) => ({
          id: c.id,
          label: c.name,
          sublabel: c.providerName,
          rpmLimit: c.rpmLimit,
          tpmLimit: c.tpmLimit,
          status: c.status,
        }))
      : [];
  const keys: RateLimitItem[] =
    keysRes.status === 'fulfilled'
      ? keysRes.value.rows.map((k) => ({
          id: k.id,
          label: k.name,
          sublabel: `${k.subscriptionId != null ? t('plan') : t('balance')} · ${k.keyPreview}`,
          rpmLimit: k.rpmLimit,
          tpmLimit: k.tpmLimit,
          dailySpendLimit: k.dailySpendLimit,
          status: k.status,
        }))
      : [];

  const allFailed =
    usersRes.status === 'rejected' &&
    modelsRes.status === 'rejected' &&
    channelsRes.status === 'rejected' &&
    keysRes.status === 'rejected';
  let error: string | null = null;
  if (allFailed) {
    error = usersRes.reason instanceof Error ? usersRes.reason.message : tc('loadFailed');
  }

  return (
    <ListPage
      title={t('title')}
      icon={<GaugeIcon className="size-5 text-muted-foreground" />}
      description={t('description')}
      searchPlaceholder={t('searchPlaceholder')}
      q={q}
      searchParams={{ q }}
      error={error}
    >
      <RateLimitsClient users={users} models={models} channels={channels} keys={keys} />
    </ListPage>
  );
}
