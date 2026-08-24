import { requirePermission } from '@/server/get-admin';
import { adminApi } from '@/server/admin-api';
import { UsersRound } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { ApiError, type AdminRateCardRow, type Paginated } from '@tillgate/api-client';
import { ListPage } from '@/components/list-page';
import { firstParam, parseListSearchParams } from '@/lib/list-query';

import { UsersContent } from '@/features/users/users-content';
import { UsersExport } from '@/features/users/users-export';
import { UsersStatusFilter } from '@/features/users/users-status-filter';
import { UsersEnterpriseFilter } from '@/features/users/users-enterprise-filter';
import type { RateCardOption, AdminUserRow } from '@tillgate/api-client';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** 用户列表拉取：query 装配 + 失败降级（错误文案经返回值上抛页面展示） */
async function fetchUsersPage(filters: {
  page: number;
  sortBy: string | undefined;
  order: 'asc' | 'desc';
  q: string;
  status: string;
  enterprise: string;
}): Promise<{ rows: AdminUserRow[]; total: number; failed: boolean; apiError: string | null }> {
  const query = new URLSearchParams({
    page: String(filters.page),
    page_size: String(PAGE_SIZE),
    sort_by: filters.sortBy ?? 'createdAt',
    order: filters.order,
  });
  if (filters.q) query.set('q', filters.q);
  if (filters.status === '0' || filters.status === '1') query.set('status', filters.status);
  if (filters.enterprise === '0' || filters.enterprise === '1') {
    query.set('enterprise', filters.enterprise);
  }
  try {
    const data = await adminApi().get<Paginated<AdminUserRow>>(`/v1/users?${query.toString()}`);
    return { rows: data.rows ?? [], total: data.total ?? 0, failed: false, apiError: null };
  } catch (error) {
    return {
      rows: [],
      total: 0,
      failed: true,
      apiError: error instanceof ApiError ? error.message : null,
    };
  }
}

/** 费率卡选项拉取：失败降级空列表（不阻塞用户列表） */
async function fetchRateCardOptions(): Promise<RateCardOption[]> {
  try {
    const rc = await adminApi().get<Paginated<AdminRateCardRow>>('/v1/rate-cards');
    // 修复笔误：原 `rc.rows ?? rc.rows` 两侧同值（nullish 时向 .map 抛异常）；改空数组直取同一降级结果
    return (rc.rows ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      coefficient: r.coefficient,
    }));
  } catch {
    return [];
  }
}

export default async function UsersPage({ searchParams }: PageProps) {
  await requirePermission('users:read');
  const sp = await searchParams;
  const t = await getTranslations('users');
  const tc = await getTranslations('common');
  const { q, page, sortBy, order } = parseListSearchParams(sp);
  const status = firstParam(sp.status) ?? 'all';
  const enterprise = firstParam(sp.enterprise) ?? 'all';
  // 失败文案在页面侧兜底翻译（fetch 层只回传 ApiError 原文，非 ApiError 由页面回落通用文案）
  const { rows, total, failed, apiError } = await fetchUsersPage({
    page,
    sortBy,
    order,
    q,
    status,
    enterprise,
  });
  const loadError = failed ? (apiError ?? tc('loadFailed')) : null;
  const rateCards = await fetchRateCardOptions();

  return (
    <ListPage
      title={t('title')}
      icon={<UsersRound className="size-5 text-muted-foreground" />}
      description={t('description')}
      total={total}
      totalUnit={t('totalUnit')}
      searchPlaceholder={t('searchPlaceholder')}
      q={q}
      searchParams={{ q, status, enterprise, sort_by: sortBy, order: sortBy ? order : undefined }}
      filters={
        <>
          <UsersStatusFilter value={status} />
          <UsersEnterpriseFilter value={enterprise} />
        </>
      }
      actions={<UsersExport users={rows} />}
      error={loadError}
      page={page}
      pageSize={PAGE_SIZE}
    >
      <UsersContent users={rows} rateCards={rateCards} />
    </ListPage>
  );
}
