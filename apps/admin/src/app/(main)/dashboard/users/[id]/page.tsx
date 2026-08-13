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
  type Paginated,
  type TransactionRow,
} from '@ai-gateway/api-client';
import { Button } from '@ai-gateway/ui/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@ai-gateway/ui/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@ai-gateway/ui/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ai-gateway/ui/components/ui/tabs';

import { UserActions } from './_components/user-actions';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function UserDetailPage({ params }: PageProps) {
  const { id } = await params;
  const userId = Number(id);
  if (!Number.isFinite(userId) || userId <= 0) notFound();

  let user: AdminUserRow | null = null;
  let error: string | null = null;
  try {
    user = await adminFetch<AdminUserRow>(`/api/admin/users/${userId}`);
  } catch (e) {
    error = e instanceof ApiError ? e.message : '加载失败';
  }

  // 并行拉取流水和审计
  const [txResult, auditResult] = await Promise.allSettled([
    adminFetch<Paginated<TransactionRow>>(
      `/api/admin/users/${userId}/transactions?page=1&page_size=50`,
    ),
    adminFetch<Paginated<AuditLogRow>>(
      `/api/admin/audit-logs?targetId=${userId}&page=1&page_size=50`,
    ),
  ]);

  const transactions = txResult.status === 'fulfilled' ? txResult.value.list : [];
  const auditLogs = auditResult.status === 'fulfilled' ? auditResult.value.list : [];

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
            <Field label="已结算余额" value={fmtBalance(user.balance)} />
            <Field label="处理中预留" value={fmtBalance(user.reservedBalance)} />
            <Field label="可用额度" value={fmtBalance(user.availableBalance)} />
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
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-20">ID</TableHead>
                    <TableHead className="w-24">类型</TableHead>
                    <TableHead className="text-right">变动</TableHead>
                    <TableHead className="text-right">变动后</TableHead>
                    <TableHead>关联</TableHead>
                    <TableHead>备注</TableHead>
                    <TableHead>操作人</TableHead>
                    <TableHead className="w-44">时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {transactions.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                        暂无流水
                      </TableCell>
                    </TableRow>
                  ) : (
                    transactions.map((t) => {
                      const amount = Number(t.amount);
                      const tone =
                        amount > 0
                          ? 'text-emerald-700 dark:text-emerald-300'
                          : amount < 0
                            ? 'text-destructive'
                            : '';
                      return (
                        <TableRow key={t.id}>
                          <TableCell className="text-xs text-muted-foreground tabular-nums">
                            #{t.id}
                          </TableCell>
                          <TableCell className="text-xs">{t.type}</TableCell>
                          <TableCell className={'text-right font-medium tabular-nums ' + tone}>
                            {amount >= 0 ? '+' : ''}
                            {fmtBalance(t.amount)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {fmtBalance(t.balanceAfter)}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {t.refType ? `${t.refType}#${t.refId ?? ''}` : '—'}
                          </TableCell>
                          <TableCell className="max-w-xs text-xs text-muted-foreground">
                            {t.remark ?? '—'}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {t.createdBy ?? '—'}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {fmtDateTime(t.createdAt)}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="audit">
          <Card>
            <CardContent className="px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-20">ID</TableHead>
                    <TableHead>管理员</TableHead>
                    <TableHead className="w-40">动作</TableHead>
                    <TableHead className="w-32">目标类型</TableHead>
                    <TableHead>详情</TableHead>
                    <TableHead className="w-44">时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {auditLogs.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                        暂无审计日志
                      </TableCell>
                    </TableRow>
                  ) : (
                    auditLogs.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell className="text-xs text-muted-foreground tabular-nums">
                          #{a.id}
                        </TableCell>
                        <TableCell className="text-xs">{a.adminSubject ?? '—'}</TableCell>
                        <TableCell className="text-xs font-medium">{a.action}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {a.targetType}
                        </TableCell>
                        <TableCell className="max-w-md text-xs text-muted-foreground">
                          {a.detail ? JSON.stringify(a.detail) : '—'}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {fmtDateTime(a.createdAt)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
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
