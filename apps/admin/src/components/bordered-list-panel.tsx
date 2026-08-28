import {
  Button,
  Input,
  ListContent,
  ListFooter,
  ListPanel,
  ListToolbar,
  ListToolbarGroup,
} from '@tillgate/ui';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { SearchIcon, XIcon } from 'lucide-react';

import { Pager } from '@/components/pager';
import { listHref, type SearchParamsInput } from '../lib/list-query';

/** 带边框列表面板：搜索工具栏（hidden 参数保留 + 原生 GET 提交）+ 内容 + 分页 */
export function BorderedListPanel({
  searchParams,
  searchPlaceholder,
  filters,
  q,
  error,
  children,
  page,
  pageSize,
  total,
}: {
  searchParams: SearchParamsInput;
  searchPlaceholder?: string;
  filters?: ReactNode;
  q?: string;
  error?: string | null;
  children: ReactNode;
  page?: number;
  pageSize?: number;
  total?: number;
}) {
  const t = useTranslations('ui');
  // 除 q/page 外的现有筛选以 hidden input 保留：搜索后不丢筛选且回第 1 页
  const hiddenParams = Object.entries(searchParams).filter(
    ([key]) => key !== 'q' && key !== 'page',
  );
  const clearSearchHref = listHref(searchParams, { q: undefined, page: undefined });
  return (
    <ListPanel>
      {(searchPlaceholder || filters) && (
        <ListToolbar>
          <ListToolbarGroup className="flex-1">
            {searchPlaceholder ? (
              <form method="GET" className="flex w-full min-w-0 items-center gap-2 sm:max-w-lg">
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
        {error ? <p className="p-8 text-center text-sm text-destructive">{error}</p> : children}
      </ListContent>
      {page !== undefined && pageSize !== undefined && total !== undefined && total > pageSize ? (
        <ListFooter>
          <Pager
            page={page}
            totalPages={Math.max(1, Math.ceil(total / pageSize))}
            total={total}
            searchParams={searchParams}
          />
        </ListFooter>
      ) : null}
    </ListPanel>
  );
}
