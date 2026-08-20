import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeftIcon } from 'lucide-react';

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
    error = e instanceof ApiError ? e.message : '加载失败';
  }

  // 并行拉取流水和该用户的审计（专用接口 targetType=user——此前误用全局列表，
  // targetId 不在全局 schema 里被剥掉，展示的是全站日志，R10 一并根治）
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
            <ArrowLeftIcon /> 返回用户列表
          </Link>
        </Button>
        <Card>
          <CardContent className="p-6 text-sm text-destructive">
            {error ?? '用户不存在'}
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
      render: (t) => <span className="text-xs text-muted-foreground tabular-nums">#{t.id}</span>,
    },
    {
      key: 'type',
      header: '类型',
      headerClassName: 'w-24',
      render: (t) => <span className="text-xs">{t.type}</span>,
    },
    {
      key: 'amount',
      header: '变动',
      sortable: true,
      align: 'right',
      render: (t) => {
        const amount = Number(t.amount);
        const tone =
          amount > 0
            ? 'text-emerald-700 dark:text-emerald-300'
            : amount < 0
              ? 'text-destructive'
              : '';
        return (
          <span className={'text-right font-medium tabular-nums ' + tone}>
            {amount >= 0 ? '+' : ''}
            {fmtBalance(t.amount)}
          </span>
        );
      },
    },
    {
      key: 'balanceAfter',
      header: '变动后',
      align: 'right',
      render: (t) => <span className="text-right tabular-nums">{fmtBalance(t.balanceAfter)}</span>,
    },
    {
      key: 'ref',
      header: '关联',
      render: (t) => (
        <span className="text-xs text-muted-foreground">
          {t.refType ? `${t.refType}#${t.refId ?? ''}` : '—'}
        </span>
      ),
    },
    {
      key: 'remark',
      header: '备注',
      render: (t) => (
        <span className="block max-w-xs truncate text-xs text-muted-foreground">
          {t.remark ?? '—'}
        </span>
      ),
    },
    {
      key: 'createdBy',
      header: '操作人',
      render: (t) => <span className="text-xs text-muted-foreground">{t.createdBy ?? '—'}</span>,
    },
    {
      key: 'createdAt',
      header: '时间',
      sortable: true,
      headerClassName: 'w-44',
      render: (t) => (
        <span className="text-xs text-muted-foreground">{fmtDateTime(t.createdAt)}</span>
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
      header: '管理员',
      render: (a) => <span className="text-xs">{a.adminSubject ?? '—'}</span>,
    },
    {
      key: 'action',
      header: '动作',
      sortable: true,
      headerClassName: 'w-40',
      render: (a) => <span className="text-xs font-medium">{a.action}</span>,
    },
    {
      key: 'targetType',
      header: '目标类型',
      headerClassName: 'w-32',
      render: (a) => <span className="text-xs text-muted-foreground">{a.targetType}</span>,
    },
    {
      key: 'detail',
      header: '详情',
      render: (a) => (
        <span className="block max-w-md truncate text-xs text-muted-foreground">
          {a.detail ? JSON.stringify(a.detail) : '—'}
        </span>
      ),
    },
    {
      key: 'createdAt',
      header: '时间',
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
          <ArrowLeftIcon /> 返回用户列表
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
                <span>账号 {user.subject}</span>
                <span>·</span>
                <span>{user.email ?? '无邮箱'}</span>
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
              label="状态"
              value={
                user.status === 0
                  ? '正常'
                  : `已封禁${user.freezeReason ? `（${user.freezeReason}）` : ''}`
              }
            />
            <Field label="账户类型" value={user.isEnterprise ? '企业' : '个人'} />
            <Field label="已结算余额" value={fmtBalance(user.balance)} />
            <Field label="处理中预留" value={fmtBalance(user.reservedBalance)} />
            <Field label="可用额度" value={fmtBalance(user.availableBalance)} />
            <Field label="透支上限" value={fmtBalance(user.creditLimit)} />
            <Field
              label="每日花费上限"
              value={user.dailySpendLimit === null ? '不限' : fmtBalance(user.dailySpendLimit)}
            />
            <Field label="费率卡" value={user.rateCardName ?? '—'} />
            <Field
              label="RPM 限额"
              value={user.rpmLimit === null ? '默认' : String(user.rpmLimit)}
            />
            <Field
              label="TPM 限额"
              value={user.tpmLimit === null ? '默认' : String(user.tpmLimit)}
            />
            <Field label="Issuer" value={user.issuer ?? '—'} />
            <Field label="最近登录" value={fmtDateTime(user.lastLoginAt)} />
            <Field label="创建时间" value={fmtDateTime(user.createdAt)} />
          </dl>
        </CardContent>
      </Card>

      <Tabs defaultValue="tx">
        <TabsList>
          <TabsTrigger value="tx">交易流水</TabsTrigger>
          <TabsTrigger value="audit">审计日志</TabsTrigger>
        </TabsList>
        <TabsContent value="tx">
          <Card>
            <CardContent className="px-0">
              {/* 时间范围筛选（GET 表单，服务端渲染；与后端 from/to 过滤对齐） */}
              <form className="flex items-end gap-2 px-6 pb-2" method="get">
                <div className="space-y-1">
                  <label htmlFor="from" className="text-xs text-muted-foreground">
                    开始日期
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
                    结束日期
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
                  筛选
                </button>
                {fromRaw || toRaw ? (
                  <a
                    href={`/dashboard/users/${userId}`}
                    className="h-8 leading-8 text-sm text-muted-foreground underline-offset-2 hover:underline"
                  >
                    清除
                  </a>
                ) : null}
              </form>
              <DataTable
                columns={txColumns}
                rows={transactions}
                rowKey={(t) => t.id}
                sort={{ sortBy, order }}
                searchParams={{ tpage: String(txPage), from: fromRaw, to: toRaw }}
                empty="暂无流水"
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
                empty="暂无审计日志"
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
