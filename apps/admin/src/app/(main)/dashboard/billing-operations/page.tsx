import { ShieldAlert } from 'lucide-react';
import { ApiError, adminFetch, fmtDateTime, formatMoney } from '@ai-gateway/api-client';
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
import { ReviewActions } from './_components/review-actions';

export const dynamic = 'force-dynamic';

interface BillingCase {
  requestId: string;
  userId: number;
  status: 'dead' | 'uncertain';
  revision: number;
  reservedAmount: string;
  failureCode: string | null;
  failureClass: string | null;
  lastError: string | null;
  updatedAt: string;
}

export default async function BillingOperationsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const requested = (await searchParams).status;
  const status = requested === 'dead' ? 'dead' : 'uncertain';
  let items: BillingCase[] = [];
  let error: string | null = null;
  try {
    const response = await adminFetch<{ items: BillingCase[] }>(
      `/api/admin/billing-operations?status=${status}&limit=100`,
    );
    items = response.items;
  } catch (caught) {
    error = caught instanceof ApiError ? caught.message : '加载失败';
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <ShieldAlert className="size-5" />
          计费异常复核
        </h1>
        <p className="text-sm text-muted-foreground">
          不确定请求不会自动退款；所有处理均要求版本校验并写入审计日志。
        </p>
      </div>
      <div className="flex gap-2 text-sm">
        <a
          className={`rounded border px-3 py-1 ${status === 'uncertain' ? 'bg-muted' : ''}`}
          href="?status=uncertain"
        >
          待确认
        </a>
        <a
          className={`rounded border px-3 py-1 ${status === 'dead' ? 'bg-muted' : ''}`}
          href="?status=dead"
        >
          结算死信
        </a>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>异常请求</CardTitle>
          <CardDescription>共 {items.length} 条</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {error ? (
            <p className="p-8 text-center text-destructive">{error}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>请求 ID</TableHead>
                  <TableHead>用户</TableHead>
                  <TableHead>预扣</TableHead>
                  <TableHead>原因</TableHead>
                  <TableHead>更新时间</TableHead>
                  <TableHead>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center">
                      暂无异常请求
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((item) => (
                    <TableRow key={item.requestId}>
                      <TableCell>
                        <code className="text-xs">{item.requestId}</code>
                      </TableCell>
                      <TableCell>#{item.userId}</TableCell>
                      <TableCell>¥{formatMoney(item.reservedAmount)}</TableCell>
                      <TableCell className="max-w-64 text-xs">
                        {item.failureClass ?? item.failureCode ?? item.lastError ?? '—'}
                      </TableCell>
                      <TableCell>{fmtDateTime(item.updatedAt)}</TableCell>
                      <TableCell>
                        <ReviewActions
                          requestId={item.requestId}
                          revision={item.revision}
                          status={item.status}
                        />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
