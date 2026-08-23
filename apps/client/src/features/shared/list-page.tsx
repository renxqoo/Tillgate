import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { SearchIcon } from 'lucide-react';

import { Card, CardContent, CardHeader, Input } from '@tokenlens/ui';

import type { SearchParamsInput } from '@/server/list-query';

import { Pager } from './pager';

/**
 * 统一「列表搜索页」骨架（所有列表页共用；server page 直接用，无 "use client"）：
 *
 *   页头（图标 + 标题 + 共 N 条 | actions 插槽）
 *   aboveList 插槽（页头与 Card 之间）
 *   Card（搜索表单 + filters 插槽 | 表格 children | 分页 Pager）
 *
 * - 搜索是原生 GET form：提交后整组参数进 URL；除 q/page 外的现有筛选
 *   以 hidden input 保留（搜索永远回第 1 页且不丢筛选）。
 * - children 放 DataTable；children 传 null 且无 error 时整个列表 Card 不渲染
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
  const hiddenParams = Object.entries(searchParams).filter(([key]) => key !== 'q' && key !== 'page');

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            {icon}
            {title}
          </h1>
          {description ? (
            <p className="text-sm text-muted-foreground">
              {description}
              {total !== undefined ? ` · ${t('totalLine', { count: total, unit })}` : ''}
            </p>
          ) : total !== undefined ? (
            <p className="text-sm text-muted-foreground">{t('totalLine', { count: total, unit })}</p>
          ) : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>

      {aboveList}

      {error || children ? (
        unbordered ? (
          error ? <p className="p-8 text-center text-sm text-destructive">{error}</p> : children
        ) : (
          <Card>
            {(searchPlaceholder || filters) && (
              <CardHeader className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  {searchPlaceholder ? (
                    <form method="GET" className="relative">
                      {hiddenParams.map(([key, value]) =>
                        Array.isArray(value) ? (
                          value.map((v, i) => (
                            <input key={`${key}-${i}`} type="hidden" name={key} value={v} />
                          ))
                        ) : (
                          <input key={key} type="hidden" name={key} value={value ?? ''} />
                        ),
                      )}
                      <SearchIcon className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        name="q"
                        defaultValue={q ?? ''}
                        placeholder={searchPlaceholder}
                        className="w-56 pl-9"
                      />
                    </form>
                  ) : (
                    <div />
                  )}
                  {filters ? <div className="flex flex-wrap items-center gap-2">{filters}</div> : null}
                </div>
              </CardHeader>
            )}
            <CardContent className="px-0">
              {error ? <p className="p-8 text-center text-sm text-destructive">{error}</p> : children}
            </CardContent>
            {page !== undefined &&
            pageSize !== undefined &&
            total !== undefined &&
            total > pageSize ? (
              <CardContent className="px-6 pb-4 pt-0">
                <Pager
                  page={page}
                  totalPages={Math.max(1, Math.ceil(total / pageSize))}
                  searchParams={searchParams}
                />
              </CardContent>
            ) : null}
          </Card>
        )
      ) : null}
    </div>
  );
}
