import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { SearchIcon, XIcon } from 'lucide-react';

import {
  Button,
  Input,
  ListContent,
  ListFooter,
  ListPanel,
  ListToolbar,
  ListToolbarGroup,
  PageHeader,
} from '@tokenlens/ui';

import { listHref, type SearchParamsInput } from '@/server/list-query';

import { Pager } from './pager';

/**
 * 统一「列表搜索页」骨架（所有列表页共用；server page 直接用，无 "use client"）：
 *
 *   页头（图标 + 标题 + 共 N 条 | actions 插槽）
 *   aboveList 插槽（页头与列表面板之间）
 *   ListPanel（搜索表单 + filters 插槽 | 表格 children | 分页 Pager）
 *
 * - 搜索是原生 GET form：提交后整组参数进 URL；除 q/page 外的现有筛选
 *   以 hidden input 保留（搜索永远回第 1 页且不丢筛选）。
 * - children 放 DataTable；children 传 null 且无 error 时整个列表面板不渲染
 *   （无数据隐藏列表）；分页条仅在超过一页（total > pageSize）时渲染。
 * - unbordered：内容不套 Card 直接平铺（操练场/邀请/账单等非列表形态页用）。
 */
export function ListPage({
  title,
  description,
  icon,
  total,
  totalUnit,
  searchPlaceholder,
  q,
  searchParams = {},
  filters,
  actions,
  aboveList,
  error,
  children,
  page,
  pageSize,
  unbordered,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  total?: number;
  totalUnit?: string;
  searchPlaceholder?: string;
  q?: string;
  searchParams?: SearchParamsInput;
  filters?: ReactNode;
  actions?: ReactNode;
  aboveList?: ReactNode;
  error?: string | null;
  children: ReactNode;
  page?: number;
  pageSize?: number;
  unbordered?: boolean;
}) {
  const t = useTranslations('ui');
  const unit = totalUnit ?? t('itemsUnit');
  const hiddenParams = Object.entries(searchParams).filter(
    ([key]) => key !== 'q' && key !== 'page',
  );
  const clearSearchHref = listHref(searchParams, { q: undefined, page: undefined });
  const totalLine = total !== undefined ? t('totalLine', { count: total, unit }) : undefined;
  const descriptionLine =
    description || totalLine ? (
      <>
        {description}
        {description && totalLine ? ' · ' : null}
        {totalLine}
      </>
    ) : undefined;

  return (
    <div className="flex flex-col gap-4 md:gap-6">
      <PageHeader title={title} description={descriptionLine} icon={icon} actions={actions} />

      {aboveList}

      {error || children ? (
        unbordered ? (
          error ? (
            <p className="p-8 text-center text-sm text-destructive">{error}</p>
          ) : (
            children
          )
        ) : (
          <ListPanel>
            {(searchPlaceholder || filters) && (
              <ListToolbar>
                <ListToolbarGroup className="flex-1">
                  {searchPlaceholder ? (
                    <form
                      method="GET"
                      className="flex w-full min-w-0 items-center gap-2 sm:max-w-lg"
                    >
                      {hiddenParams.map(([key, value]) =>
                        Array.isArray(value) ? (
                          value.map((v, i) => (
                            <input key={`${key}-${i}`} type="hidden" name={key} value={v} />
                          ))
                        ) : (
                          <input key={key} type="hidden" name={key} value={value ?? ''} />
                        ),
                      )}
                      <div className="relative min-w-0 flex-1">
                        <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          name="q"
                          defaultValue={q ?? ''}
                          placeholder={searchPlaceholder}
                          className="w-full pl-9"
                        />
                      </div>
                      <Button type="submit" variant="outline">
                        <SearchIcon data-icon="inline-start" />
                        <span className="hidden sm:inline">{t('search')}</span>
                      </Button>
                      {q ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          render={<a href={clearSearchHref} aria-label={t('clearSearch')} />}
                        >
                          <XIcon />
                        </Button>
                      ) : null}
                    </form>
                  ) : null}
                </ListToolbarGroup>
                {filters ? <ListToolbarGroup>{filters}</ListToolbarGroup> : null}
              </ListToolbar>
            )}
            <ListContent>
              {error ? (
                <p className="p-8 text-center text-sm text-destructive">{error}</p>
              ) : (
                children
              )}
            </ListContent>
            {page !== undefined &&
            pageSize !== undefined &&
            total !== undefined &&
            total > pageSize ? (
              <ListFooter>
                <Pager
                  page={page}
                  totalPages={Math.max(1, Math.ceil(total / pageSize))}
                  searchParams={searchParams}
                />
              </ListFooter>
            ) : null}
          </ListPanel>
        )
      ) : null}
    </div>
  );
}
