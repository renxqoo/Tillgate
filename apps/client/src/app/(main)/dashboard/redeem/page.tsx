import { GiftIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { getLocale, getTranslations } from 'next-intl/server';

import { ApiError, type RedeemHistoryItem, type RedeemHistoryPage } from '@tillgate/api-client';
import { Button, DataTable, type DataTableColumn } from '@tillgate/ui';

import { formatDateTime, formatMoney, type DisplayLocale } from '@/features/shared/format';
import { signedAmountTone } from '@/features/shared/money-tone';
import { ListPage } from '@/features/shared/list-page';
import { RedeemForm } from '@/features/wallet/redeem-form';
import { listHref, parseListSearchParams } from '@/server/list-query';
import { createClientApi } from '@/server/api';
import { requireMe } from '@/server/session';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

// —— 模块级渲染函数：列 cell / t.rich 富文本回调内联 JSX 会被判定为渲染期定义组件
// （react/no-unstable-nested-components），统一提为模块级小函数返回 ReactNode ——

function renderAmountCell(r: RedeemHistoryItem, locale: DisplayLocale) {
  return (
    <span className={`text-right font-medium tabular-nums ${signedAmountTone(r.amount, locale)}`}>
      +{formatMoney(r.amount, locale)}
    </span>
  );
}

function renderBatchCell(r: RedeemHistoryItem) {
  return <span className="text-sm text-muted-foreground">{r.batchName ?? '—'}</span>;
}

function renderTimeCell(r: RedeemHistoryItem, locale: DisplayLocale) {
  return <span className="text-xs text-muted-foreground">{formatDateTime(r.usedAt, locale)}</span>;
}

/** t.rich 的 link 富文本渲染：指向钱包流水页 */
function renderDescriptionLink(chunks: ReactNode) {
  return (
    <Link href="/dashboard/transactions" className="underline hover:text-foreground">
      {chunks}
    </Link>
  );
}

export default async function RedeemPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const locale = await getLocale();
  const t = await getTranslations('redeem');
  const { page } = parseListSearchParams(sp);
  const api = createClientApi();
  await requireMe(api);

  let history: RedeemHistoryItem[] = [];
  let loadError: string | null = null;
  let hasMore = false;
  try {
    // 信封只 rows 无 total——「加载更多」按满页判断续读
    const qs = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    const result = await api.get<RedeemHistoryPage>(`/v1/redeem/history?${qs.toString()}`);
    // catch 形参按 catch-error-name 规则命名为 error，外层改名为 loadError：原写法
    // 赋给了 catch 参数导致外层恒为 null，加载失败提示永不上屏——真实 bug 一并修复
    ({ rows: history } = result);
    hasMore = result.rows.length === PAGE_SIZE;
  } catch (error) {
    loadError = error instanceof ApiError ? error.message : null;
  }

  const columns: DataTableColumn<RedeemHistoryItem>[] = [
    {
      key: 'amount',
      header: t('colValue'),
      align: 'right',
      cell: (r) => renderAmountCell(r, locale),
    },
    {
      key: 'batchName',
      header: t('colBatch'),
      cell: (r) => renderBatchCell(r),
    },
    {
      key: 'usedAt',
      header: t('colRedeemedAt'),
      cell: (r) => renderTimeCell(r, locale),
    },
  ];

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <ListPage
        title={t('title')}
        icon={<GiftIcon className="size-5 text-muted-foreground" />}
        description={t.rich('description', {
          link: (chunks) => renderDescriptionLink(chunks),
        })}
        total={undefined}
        error={loadError}
        searchParams={{ page: page > 1 ? String(page) : undefined }}
        aboveList={<RedeemForm />}
      >
        {history.length > 0 ? (
          <>
            <DataTable
              columns={columns}
              rows={history}
              rowKey={(r) => r.codeId}
              empty={t('empty')}
            />
            {hasMore && !loadError ? (
              <div className="flex justify-center p-4">
                <Button
                  variant="outline"
                  size="sm"
                  render={<a href={listHref(sp, { page: page + 1 })} />}
                >
                  {t('loadMore')}
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </ListPage>
    </div>
  );
}
