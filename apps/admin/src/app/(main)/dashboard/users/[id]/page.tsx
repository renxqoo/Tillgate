import { requirePermission } from '@/server/get-admin';
import { fetchRateCardOptions } from '@/server/admin-list';
import { Button, Card, CardContent, Tabs, TabsList, TabsTrigger } from '@tillgate/ui';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeftIcon } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import { ApiError } from '@tillgate/api-client';
import type { AdminTransactionRow, AdminUserRow, AuditLogRow } from '@tillgate/api-client';
import { adminApi } from '@/server/admin-api';
import { fetchAdminList } from '@/server/admin-list';
import { firstParam } from '@/lib/list-query';

import {
  AuditTab,
  TransactionsTab,
  UserProfileCard,
  buildAuditColumns,
  buildTxColumns,
} from '@/features/users/user-detail-views';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** allSettled 列表结果降级：失败 → 空列表 + 0（错误经 loadError 主通道展示） */
function settledList<T>(result: PromiseSettledResult<{ rows: T[]; total: number }>): {
  rows: T[];
  total: number;
} {
  return result.status === 'fulfilled' ? result.value : { rows: [], total: 0 };
}

function isoDateParam(v: string | undefined): string | null {
  // 只接受 YYYY-MM-DD（防注入/畸形参数直传后端）
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  return new Date(`${v}T00:00:00Z`).toISOString();
}

export default async function UserDetailPage({ params, searchParams }: PageProps) {
  await requirePermission('users:read');
  const { id } = await params;
  const locale = await getLocale();
  const t = await getTranslations('users');
  const tc = await getTranslations('common');
  const userId = Number(id);
  if (!Number.isFinite(userId) || userId <= 0) notFound();
  const sp = await searchParams;
  const fromRaw = firstParam(sp.from);
  const toRaw = firstParam(sp.to);
  const from = isoDateParam(fromRaw);
  const to = isoDateParam(toRaw);
  const txPage = Math.max(1, Number(firstParam(sp.tpage) ?? '1') || 1);
  const auditPage = Math.max(1, Number(firstParam(sp.apage) ?? '1') || 1);
  const sortBy = firstParam(sp.sort_by);
  const order = firstParam(sp.order) === 'asc' ? 'asc' : 'desc';

  let user: AdminUserRow | null = null;
  let loadError: string | null = null;
  try {
    user = await adminApi().get<AdminUserRow>(`/v1/users/${userId}`);
  } catch (error) {
    loadError = error instanceof ApiError ? error.message : tc('loadFailed');
  }

  // 并行拉取流水和该用户的审计（专用接口 targetType=user——必须按用户过滤，
  // 全局列表 schema 会剥掉 targetId，展示的会是全站日志）
  const [txResult, auditResult] = await Promise.allSettled([
    fetchAdminList<AdminTransactionRow>(`/v1/users/${userId}/transactions`, {
      page: txPage,
      pageSize: PAGE_SIZE,
      sortBy,
      order,
      extra: {
        from: from ?? undefined,
        to: to ?? undefined,
        q: firstParam(sp.q),
      },
    }),
    fetchAdminList<AuditLogRow>(`/v1/users/${userId}/audit-logs`, {
      page: auditPage,
      pageSize: PAGE_SIZE,
      sortBy,
      order,
      extra: { q: firstParam(sp.q) },
    }),
  ]);

  const { rows: transactions, total: txTotal } = settledList(txResult);
  const { rows: auditLogs, total: auditTotal } = settledList(auditResult);

  if (!user) {
    return (
      <div className="flex flex-col gap-4">
        <Button
          variant="ghost"
          size="sm"
          className="w-fit"
          render={
            <Link href="/dashboard/users">
              <ArrowLeftIcon /> {t('backToUsers')}
            </Link>
          }
        />
        <Card>
          <CardContent className="p-6 text-sm text-destructive">
            {loadError ?? t('userNotFound')}
          </CardContent>
        </Card>
      </div>
    );
  }

  const rateCards = await fetchRateCardOptions();
  const txColumns = buildTxColumns(t, tc, locale);
  const auditColumns = buildAuditColumns(t, tc);

  return (
    <div className="flex w-full flex-col gap-4">
      <Button
        variant="ghost"
        size="sm"
        className="w-fit"
        render={
          <Link href="/dashboard/users">
            <ArrowLeftIcon /> {t('backToUsers')}
          </Link>
        }
      />

      <UserProfileCard user={user} rateCards={rateCards} t={t} tc={tc} />

      <Tabs defaultValue="tx" className="w-full">
        <TabsList>
          <TabsTrigger value="tx">{t('transactions')}</TabsTrigger>
          <TabsTrigger value="audit">{t('auditLogs')}</TabsTrigger>
        </TabsList>
        <TransactionsTab
          userId={userId}
          fromRaw={fromRaw}
          toRaw={toRaw}
          txPage={txPage}
          auditPage={auditPage}
          transactions={transactions}
          txTotal={txTotal}
          txColumns={txColumns}
          sortBy={sortBy}
          order={order}
          t={t}
          tc={tc}
        />
        <AuditTab
          auditLogs={auditLogs}
          auditTotal={auditTotal}
          auditPage={auditPage}
          txPage={txPage}
          auditColumns={auditColumns}
          sortBy={sortBy}
          order={order}
          t={t}
        />
      </Tabs>
    </div>
  );
}
