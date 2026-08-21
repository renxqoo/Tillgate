import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeftIcon } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import {
  ApiError,
  adminFetch,
  fmtBalance,
  fmtDateTime,
  type AdminUserRow,
  type AuditLogRow,
  type AdminTransactionRow,
} from '@ai-gateway/api-client';
import { fetchAdminList } from '@ai-gateway/api-client/list';
import { signedAmountTone } from '@ai-gateway/ui/lib/money-tone';
import { Button } from '@ai-gateway/ui/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@ai-gateway/ui/components/ui/card';
import { DataTable, type DataTableColumn } from '@ai-gateway/ui/components/data-table';
import { Pager } from '@ai-gateway/ui/components/ui/pager';
import { firstParam } from '@ai-gateway/ui/lib/list-query';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ai-gateway/ui/components/ui/tabs';

import { UserActions } from './_components/user-actions';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function isoDateParam(v: string | undefined): string | null {
  // 只接受 YYYY-MM-DD（防注入/畸形参数直传后端）
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  return new Date(`${v}T00:00:00Z`).toISOString();
}

export default async function UserDetailPage({ params, searchParams }: PageProps) {
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
  let error: string | null = null;
  try {
    user = await adminFetch<AdminUserRow>(`/v1/users/${userId}`);
  } catch (e) {
    error = e instanceof ApiError ? e.message : tc('loadFailed');
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

  const transactions = txResult.status === 'fulfilled' ? txResult.value.rows : [];
  const txTotal = txResult.status === 'fulfilled' ? txResult.value.total : 0;
  const auditLogs = auditResult.status === 'fulfilled' ? auditResult.value.rows : [];
  const auditTotal = auditResult.status === 'fulfilled' ? auditResult.value.total : 0;

  if (!user) {
    return (
      <div className="flex flex-col gap-4">
        <Button asChild variant="ghost" size="sm" className="w-fit">
          <Link href="/dashboard/users">
            <ArrowLeftIcon /> {t('backToUsers')}
          </Link>
        </Button>
        <Card>
          <CardContent className="p-6 text-sm text-destructive">
            {error ?? t('userNotFound')}
          </CardContent>
        </Card>
      </div>
    );
  }

  const txColumns: DataTableColumn<AdminTransactionRow>[] = [
    {
      key: 'id',
      header: 'ID',
      sortable: true,
      headerClassName: 'w-20',
      render: (tr) => <span className="text-xs text-muted-foreground tabular-nums">#{tr.id}</span>,
    },
    {
      key: 'type',
      header: tc('type'),
      headerClassName: 'w-24',
      render: (tr) => <span className="text-xs">{tr.type}</span>,
    },
    {
      key: 'amount',
      header: t('amountChange'),
      sortable: true,
      align: 'right',
      render: (tr) => {
        const amount = Number(tr.amount);
        const tone = signedAmountTone(amount, locale);
        return (
          <span className={'text-right font-medium tabular-nums ' + tone}>
            {amount >= 0 ? '+' : ''}
            {fmtBalance(tr.amount)}
          </span>
        );
      },
    },
    {
      key: 'balanceAfter',
      header: t('balanceAfter'),
      align: 'right',
      render: (tr) => <span className="text-right tabular-nums">{fmtBalance(tr.balanceAfter)}</span>,
    },
    {
      key: 'ref',
      header: t('reference'),
      render: (tr) => (
        <span className="text-xs text-muted-foreground">
          {tr.refType ? `${tr.refType}#${tr.refId ?? ''}` : '—'}
        </span>
      ),
    },
    {
      key: 'remark',
      header: tc('remark'),
      render: (tr) => (
        <span className="block max-w-xs truncate text-xs text-muted-foreground">
          {tr.remark ?? '—'}
        </span>
      ),
    },
    {
      key: 'createdBy',
      header: t('operator'),
      render: (tr) => <span className="text-xs text-muted-foreground">{tr.createdBy ?? '—'}</span>,
    },
    {
      key: 'createdAt',
      header: tc('time'),
      sortable: true,
      headerClassName: 'w-44',
      render: (tr) => (
        <span className="text-xs text-muted-foreground">{fmtDateTime(tr.createdAt)}</span>
      ),
    },
  ];
  const auditColumns: DataTableColumn<AuditLogRow>[] = [
    {
      key: 'id',
      header: 'ID',
      sortable: true,
      headerClassName: 'w-20',
      render: (a) => <span className="text-xs text-muted-foreground tabular-nums">#{a.id}</span>,
    },
    {
      key: 'adminSubject',
      header: t('admin'),
      render: (a) => <span className="text-xs">{a.adminSubject ?? (a.actor === 'user' ? t('userSelf') : '—')}</span>,
    },
    {
      key: 'action',
      header: t('action'),
      sortable: true,
      headerClassName: 'w-40',
      render: (a) => <span className="text-xs font-medium">{a.action}</span>,
    },
    {
      key: 'targetType',
      header: t('targetType'),
      headerClassName: 'w-32',
      render: (a) => <span className="text-xs text-muted-foreground">{a.targetType}</span>,
    },
    {
      key: 'detail',
      header: tc('detail'),
      render: (a) => (
        <span className="block max-w-md truncate text-xs text-muted-foreground">
          {a.detail ? JSON.stringify(a.detail) : '—'}
        </span>
      ),
    },
    {
      key: 'createdAt',
      header: tc('time'),
      sortable: true,
      headerClassName: 'w-44',
      render: (a) => (
        <span className="text-xs text-muted-foreground">{fmtDateTime(a.createdAt)}</span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Button asChild variant="ghost" size="sm" className="w-fit">
        <Link href="/dashboard/users">
          <ArrowLeftIcon /> {t('backToUsers')}
        </Link>
      </Button>

      <Card>
        <CardHeader className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="text-xl">
                {user.displayName ?? user.subject}{' '}
                <span className="text-base font-normal text-muted-foreground">#{user.id}</span>
              </CardTitle>
              <CardDescription className="space-x-2">
                <span>{tc('account')} {user.subject}</span>
                <span>·</span>
                <span>{user.email ?? t('noEmail')}</span>
                <span>·</span>
                <span>{user.identityProvider ?? '—'}</span>
              </CardDescription>
            </div>
            <UserActions user={user} />
          </div>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm md:grid-cols-4">
            <Field
              label={tc('status')}
              value={
                user.status === 0
                  ? tc('active')
                  : t('bannedReason', { reason: user.freezeReason ?? '' })
              }
            />
            <Field label={t('accountType')} value={user.isEnterprise ? t('enterprise') : t('personal')} />
            <Field label={t('settledBalanceLabel')} value={fmtBalance(user.balance)} />
            <Field label={t('reservedBalance')} value={fmtBalance(user.reservedBalance)} />
            <Field label={t('availableBalance')} value={fmtBalance(user.availableBalance)} />
            <Field label={tc('creditLimit')} value={fmtBalance(user.creditLimit)} />
            <Field
              label={tc('dailySpendLimit')}
              value={user.dailySpendLimit === null ? tc('unlimited') : fmtBalance(user.dailySpendLimit)}
            />
            <Field label={t('rateCard')} value={user.rateCardName ?? '—'} />
            <Field
              label={t('rpmLimit')}
              value={user.rpmLimit === null ? tc('default') : String(user.rpmLimit)}
            />
            <Field
              label={t('tpmLimit')}
              value={user.tpmLimit === null ? tc('default') : String(user.tpmLimit)}
            />
            <Field label="Issuer" value={user.issuer ?? '—'} />
            <Field label={tc('lastLogin')} value={fmtDateTime(user.lastLoginAt)} />
            <Field label={tc('createdAt')} value={fmtDateTime(user.createdAt)} />
          </dl>
        </CardContent>
      </Card>

      <Tabs defaultValue="tx">
        <TabsList>
          <TabsTrigger value="tx">{t('transactions')}</TabsTrigger>
          <TabsTrigger value="audit">{t('auditLogs')}</TabsTrigger>
        </TabsList>
        <TabsContent value="tx">
          <Card>
            <CardContent className="px-0">
              {/* 时间范围筛选（GET 表单，服务端渲染；与后端 from/to 过滤对齐） */}
              <form className="flex items-end gap-2 px-6 pb-2" method="get">
                <div className="space-y-1">
                  <label htmlFor="from" className="text-xs text-muted-foreground">
                    {t('startDate')}
                  </label>
                  <input
                    id="from"
                    name="from"
                    type="date"
                    defaultValue={fromRaw ?? ''}
                    className="h-8 rounded-md border bg-transparent px-2 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor="to" className="text-xs text-muted-foreground">
                    {t('endDate')}
                  </label>
                  <input
                    id="to"
                    name="to"
                    type="date"
                    defaultValue={toRaw ?? ''}
                    className="h-8 rounded-md border bg-transparent px-2 text-sm"
                  />
                </div>
                <button type="submit" className="h-8 rounded-md border px-3 text-sm hover:bg-muted">
                  {tc('filter')}
                </button>
                {fromRaw || toRaw ? (
                  <a
                    href={`/dashboard/users/${userId}`}
                    className="h-8 leading-8 text-sm text-muted-foreground underline-offset-2 hover:underline"
                  >
                    {tc('clear')}
                  </a>
                ) : null}
              </form>
              <DataTable
                columns={txColumns}
                rows={transactions}
                rowKey={(tr) => tr.id}
                sort={{ sortBy, order }}
                searchParams={{ tpage: String(txPage), from: fromRaw, to: toRaw }}
                empty={t('noTransactions')}
              />
              {txTotal > PAGE_SIZE ? (
                <CardContent className="px-6 pb-4 pt-0">
                  <Pager
                    page={txPage}
                    totalPages={Math.max(1, Math.ceil(txTotal / PAGE_SIZE))}
                    total={txTotal}
                    pageKey="tpage"
                    searchParams={{
                      apage: String(auditPage),
                      from: fromRaw,
                      to: toRaw,
                      sort_by: sortBy,
                      order: sortBy ? order : undefined,
                    }}
                  />
                </CardContent>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="audit">
          <Card>
            <CardContent className="px-0">
              <DataTable
                columns={auditColumns}
                rows={auditLogs}
                rowKey={(a) => a.id}
                sort={{ sortBy, order }}
                searchParams={{ apage: String(auditPage), tpage: String(txPage) }}
                empty={t('noAuditLogs')}
              />
              {auditTotal > PAGE_SIZE ? (
                <CardContent className="px-6 pb-4 pt-0">
                  <Pager
                    page={auditPage}
                    totalPages={Math.max(1, Math.ceil(auditTotal / PAGE_SIZE))}
                    total={auditTotal}
                    pageKey="apage"
                    searchParams={{
                      tpage: String(txPage),
                      sort_by: sortBy,
                      order: sortBy ? order : undefined,
                    }}
                  />
                </CardContent>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}
