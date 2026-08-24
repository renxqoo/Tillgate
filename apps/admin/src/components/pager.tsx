import * as React from 'react';
import { useTranslations } from 'next-intl';
import {
  Button,
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
  cn,
} from '@tillgate/ui';

import { pagerHref } from '@/lib/pager-href';

/** 当前页两侧各展示的兄弟页数。 */
const SIBLINGS = 2;

/** 生成页码序列（含省略号）：首尾页 + 当前页 ±SIBLINGS；只缺 1 页时直接补上，缺多页才用 "..."。 */
function buildPages(page: number, totalPages: number): Array<number | '...'> {
  const maxItems = SIBLINGS * 2 + 5; // 首 + 尾 + 当前 ±2 + 2 个省略号
  if (totalPages <= maxItems) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const set = new Set<number>([1, totalPages]);
  for (let i = page - SIBLINGS; i <= page + SIBLINGS; i++) {
    if (i >= 1 && i <= totalPages) set.add(i);
  }
  const sorted = [...set].toSorted((a, b) => a - b);
  const out: Array<number | '...'> = [];
  let prev = 0;
  for (const p of sorted) {
    const gap = p - prev;
    if (gap === 2)
      out.push(prev + 1); // 只缺 1 页 → 直接显示该页，不用省略号
    else if (gap > 2) out.push('...');
    out.push(p);
    prev = p;
  }
  return out;
}

/**
 * 通用分页条（框架无关，服务端/客户端通用），支持点击页号。
 *
 * 两种驱动模式：
 *   - URL 模式（默认）：传 searchParams，翻页渲染 <a href>（只改 page、保留其余筛选）——
 *     服务端列表页用；
 *   - 受控模式：传 onPageChange，翻页渲染 <button> 回调（内存分页/客户端筛选切片——
 *     如模型市场：数据一次性下发，翻页不走路由）。
 * 总页数 <= 1（数据不足一页）时整条不渲染——所有列表页统一。
 */
export function Pager({
  page,
  totalPages,
  total,
  searchParams = {},
  pageKey = 'page',
  onPageChange,
  className,
}: {
  page: number;
  totalPages: number;
  /** 可选：总条数（显示「共 N 条」） */
  total?: number;
  /** 当前 query 参数（pageKey 会被覆盖；空值跳过）；URL 模式必传 */
  searchParams?: Record<string, string | string[] | undefined>;
  /**
   * 页码参数名。单列表页用默认 page；同页多列表（如用户详情的流水/审计）
   * 必须各用独立键（tpage/apage）——此前硬编码 page，页面读 tpage 导致
   * 点击分页参数名对不上、翻页无效。
   */
  pageKey?: string;
  /** 受控模式：提供时翻页走回调（button），不渲染链接；searchParams 被忽略 */
  onPageChange?: (page: number) => void;
  className?: string;
}) {
  const t = useTranslations('ui');
  const makeHref = (target: number): string => pagerHref(searchParams, pageKey, target);
  /** 页码目标合法性（受控模式同样要拦首尾越界点击） */
  const reachable = (target: number): boolean =>
    target >= 1 && target <= totalPages && target !== page;

  if (totalPages <= 1) return null;

  const disabledClass = 'pointer-events-none opacity-50';

  const PageControl = ({ target }: { target: number }) =>
    onPageChange ? (
      <Button
        type="button"
        variant={target === page ? 'outline' : 'ghost'}
        size="icon"
        onClick={() => reachable(target) && onPageChange(target)}
        aria-current={target === page ? 'page' : undefined}
        aria-label={t('pageN', { page: target })}
        disabled={target === page}
      >
        {target}
      </Button>
    ) : (
      <PaginationLink
        href={makeHref(target)}
        isActive={target === page}
        aria-label={t('pageN', { page: target })}
      >
        {target}
      </PaginationLink>
    );

  return (
    <div className={cn('flex w-full flex-wrap items-center justify-between gap-3', className)}>
      <span>
        {t('pageOf', { page, totalPages })}
        {total !== undefined ? ` · ${t('totalItems', { count: total })}` : ''}
      </span>
      <Pagination className="mx-0 w-auto justify-end">
        <PaginationContent>
          <PaginationItem>
            {onPageChange ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => reachable(page - 1) && onPageChange(page - 1)}
                disabled={!reachable(page - 1)}
              >
                {t('prevPage')}
              </Button>
            ) : (
              <PaginationPrevious
                href={reachable(page - 1) ? makeHref(page - 1) : undefined}
                text={t('prevPage')}
                aria-label={t('prevPage')}
                aria-disabled={!reachable(page - 1)}
                className={!reachable(page - 1) ? disabledClass : undefined}
              />
            )}
          </PaginationItem>
          {buildPages(page, totalPages).map((p, i) =>
            p === '...' ? (
              <PaginationItem key={`e${i}`}>
                <PaginationEllipsis />
              </PaginationItem>
            ) : (
              <PaginationItem key={p}>
                <PageControl target={p} />
              </PaginationItem>
            ),
          )}
          <PaginationItem>
            {onPageChange ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => reachable(page + 1) && onPageChange(page + 1)}
                disabled={!reachable(page + 1)}
              >
                {t('nextPage')}
              </Button>
            ) : (
              <PaginationNext
                href={reachable(page + 1) ? makeHref(page + 1) : undefined}
                text={t('nextPage')}
                aria-label={t('nextPage')}
                aria-disabled={!reachable(page + 1)}
                className={!reachable(page + 1) ? disabledClass : undefined}
              />
            )}
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}
