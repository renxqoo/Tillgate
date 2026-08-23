'use client';

import { useTranslations } from 'next-intl';

import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@tokenlens/ui';

import { listHref, type SearchParamsInput } from '@/server/list-query';

import { buildPages } from './pager-pages';

/**
 * 通用 URL 模式分页条：翻页渲染 <a href>（只改 page、保留其余筛选），
 * 服务端列表页用。总页数 <= 1 时整条不渲染。页码参数名可换（同页多列表
 * 各用独立键，避免键名对不上导致翻页无效）。
 */
export function Pager({
  page,
  totalPages,
  searchParams = {},
  pageKey = 'page',
}: {
  page: number;
  totalPages: number;
  searchParams?: SearchParamsInput;
  pageKey?: string;
}) {
  const t = useTranslations('ui');
  if (totalPages <= 1) return null;

  const makeHref = (target: number): string => listHref(searchParams, { [pageKey]: target });
  const reachable = (target: number): boolean =>
    target >= 1 && target <= totalPages && target !== page;

  return (
    <Pagination className="justify-end">
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            href={reachable(page - 1) ? makeHref(page - 1) : undefined}
            text={t('prevPage')}
            aria-label={t('prevPage')}
            aria-disabled={!reachable(page - 1)}
            className={!reachable(page - 1) ? 'pointer-events-none opacity-50' : undefined}
          />
        </PaginationItem>
        {buildPages(page, totalPages).map((p, i) =>
          p === '...' ? (
            <PaginationItem key={`ellipsis-${i}`}>
              <span className="px-2 text-muted-foreground">…</span>
            </PaginationItem>
          ) : (
            <PaginationItem key={p}>
              <PaginationLink
                href={makeHref(p)}
                isActive={p === page}
                aria-label={t('pageN', { page: p })}
              >
                {p}
              </PaginationLink>
            </PaginationItem>
          ),
        )}
        <PaginationItem>
          <PaginationNext
            href={reachable(page + 1) ? makeHref(page + 1) : undefined}
            text={t('nextPage')}
            aria-label={t('nextPage')}
            aria-disabled={!reachable(page + 1)}
            className={!reachable(page + 1) ? 'pointer-events-none opacity-50' : undefined}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}
