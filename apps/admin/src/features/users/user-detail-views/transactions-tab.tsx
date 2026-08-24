import { Card, CardContent, TabsContent } from '@tillgate/ui';
import type { getTranslations } from 'next-intl/server';
import type { AdminTransactionRow } from '@tillgate/api-client';

import { DataTable, type DataTableColumn } from '@/components/data-table';
import { Pager } from '@/components/pager';
import { PAGE_SIZE } from './detail-page-size';

/** 流水 Tab：时间范围筛选（GET 表单）+ 流水表 + 独立分页（tpage） */
export function TransactionsTab({
  userId,
  fromRaw,
  toRaw,
  txPage,
  auditPage,
  transactions,
  txTotal,
  txColumns,
  sortBy,
  order,
  t,
  tc,
}: {
  userId: number;
  fromRaw: string | undefined;
  toRaw: string | undefined;
  txPage: number;
  auditPage: number;
  transactions: AdminTransactionRow[];
  txTotal: number;
  txColumns: DataTableColumn<AdminTransactionRow>[];
  sortBy: string | undefined;
  order: 'asc' | 'desc';
  t: Awaited<ReturnType<typeof getTranslations<'users'>>>;
  tc: Awaited<ReturnType<typeof getTranslations<'common'>>>;
}) {
  return (
    <TabsContent value="tx" className="w-full">
      <Card className="w-full ring-border/50">
        <CardContent className="px-0">
          {/* 时间范围筛选（GET 表单，服务端渲染；与后端 from/to 过滤对齐） */}
          <form className="flex items-end gap-2 px-4 pt-4 pb-4" method="get">
            <div className="flex flex-col gap-1.5">
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
            <div className="flex flex-col gap-1.5">
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
            <CardContent className="px-4 pb-4 pt-0">
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
  );
}
