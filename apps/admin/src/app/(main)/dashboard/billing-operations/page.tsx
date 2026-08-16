import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';
import { fmtDateTime, formatMoney } from '@ai-gateway/api-client';
import { fetchAdminList } from '@ai-gateway/api-client/list';
import { ListPage } from '@ai-gateway/ui/components/list-page';
import { firstParam, listHref, parseListSearchParams } from '@ai-gateway/ui/lib/list-query';
import { DataTable } from '@ai-gateway/ui/components/data-table';
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

const PAGE_SIZE = 20;

export default async function BillingOperationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { page } = parseListSearchParams(sp);
  const requested = firstParam(sp.status);
  const status = requested === 'dead' ? 'dead' : 'uncertain';
  const { rows: items, total, error } = await fetchAdminList<BillingCase>(
    '/api/admin/billing-operations',
    { page, pageSize: PAGE_SIZE, extra: { status } },
  );

  return (
    <ListPage
      title="计费异常复核"
      icon={<ShieldAlert className="size-5 text-muted-foreground" />}
      description="不确定请求不会自动退款；所有处理均要求版本校验并写入审计日志。"
      total={total}
      filters={
        <div className="flex gap-2 text-sm">
          <a
            className={`rounded border px-3 py-1 ${status === 'uncertain' ? 'bg-muted' : ''}`}
            href={listHref({ status: 'uncertain' })}
          >
            待确认
          </a>
          <a
            className={`rounded border px-3 py-1 ${status === 'dead' ? 'bg-muted' : ''}`}
            href={listHref({ status: 'dead' })}
          >
            结算死信
          </a>
        </div>
      }
      searchParams={{ status }}
      error={error}
      page={page}
      pageSize={PAGE_SIZE}
    >
      <DataTable
        columns={[
          {
            key: 'requestId',
            header: '请求 ID',
            render: (item: BillingCase) => (
              <span>
                <code className="text-xs">{item.requestId}</code>{' '}
                <Link
                  href={`/dashboard/tracing?requestId=${item.requestId}`}
                  className="text-xs underline"
                >
                  查链路
                </Link>
              </span>
            ),
          },
          { key: 'userId', header: '用户', render: (item: BillingCase) => `#${item.userId}` },
          {
            key: 'reservedAmount',
            header: '预扣',
            align: 'right',
            render: (item: BillingCase) => `¥${formatMoney(item.reservedAmount)}`,
          },
          {
            key: 'failureClass',
            header: '原因',
            render: (item: BillingCase) => (
              <span className="max-w-64 text-xs">
                {item.failureClass ?? item.failureCode ?? item.lastError ?? '—'}
              </span>
            ),
          },
          {
            key: 'updatedAt',
            header: '更新时间',
            render: (item: BillingCase) => fmtDateTime(item.updatedAt),
          },
          {
            key: 'actions',
            header: '操作',
            render: (item: BillingCase) => (
              <ReviewActions
                requestId={item.requestId}
                revision={item.revision}
                status={item.status}
              />
            ),
          },
        ]}
        rows={items}
        rowKey={(item: BillingCase) => item.requestId}
        empty="暂无异常请求"
      />
    </ListPage>
  );
}
