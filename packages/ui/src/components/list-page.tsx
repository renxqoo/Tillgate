import type { ReactNode } from 'react';
import { SearchIcon } from 'lucide-react';

import { Card, CardContent, CardHeader } from './ui/card';
import { Input } from './ui/input';
import { Pager } from './ui/pager';
import type { SearchParamsInput } from '../lib/list-query';

/**
 * 统一「列表搜索页」骨架（admin / client 所有列表页共用）：
 *
 *   页头（图标 + 标题 + 共 N 条 | actions 插槽）
 *   aboveList 插槽（可选，页头与 Card 之间的额外内容）
 *   Card（搜索表单 + filters 插槽 | 表格 children | 分页 Pager）
 *
 * - 搜索是原生 GET form：提交后整组参数进 URL；除 q/page 外的现有筛选
 *   以 hidden input 保留，因此搜索永远回到第 1 页且不丢筛选。
 * - children 放 DataTable；children 传 null 且无 error 时整个列表 Card 不渲染
 *   （无数据隐藏列表，如兑换记录）；分页条仅在超过一页（total > pageSize）时渲染。
 * - 无 "use client"，server page 直接用；插槽里可以放任意 client 组件。
 */

export function ListPage({
  title,
  description,
  icon,
  total,
  totalUnit = '条',
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
  /** 列表总数（页头「共 N 条」） */
  total?: number;
  totalUnit?: string;
  /** 搜索框占位文案；不传则不渲染搜索框 */
  searchPlaceholder?: string;
  /** 当前搜索词（回显） */
  q?: string;
  /** 当前页完整 query 参数（hidden input 保留 + Pager 翻页） */
  searchParams?: SearchParamsInput;
  /** 筛选控件插槽（搜索栏同行；自行 router.push 的 client 筛选器放这里） */
  filters?: ReactNode;
  /** 页头右侧操作插槽（导出 / 新建按钮等） */
  actions?: ReactNode;
  /** 页头与列表 Card 之间插入的内容（如充值码页的兑换表单卡） */
  aboveList?: ReactNode;
  /** 非空时替代 children 展示错误（页面 fetch 失败文案） */
  error?: string | null;
  children: ReactNode;
  /** 传 page/pageSize 且 total 超过一页（total > pageSize）时渲染分页条 */
  page?: number;
  pageSize?: number;
  /** 去掉内容 Card 的外描边（ring）——非列表形态的页面（操练场/邀请/账单等）用 */
  unbordered?: boolean;
}) {
  const hiddenParams = Object.entries(searchParams).filter(
    ([key]) => key !== 'q' && key !== 'page',
  );

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
              {total !== undefined ? ` · 共 ${total.toLocaleString()} ${totalUnit}` : ''}
            </p>
          ) : total !== undefined ? (
            <p className="text-sm text-muted-foreground">
              共 {total.toLocaleString()} {totalUnit}
            </p>
          ) : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>

      {aboveList}

      {error || children ? (
        <Card className={unbordered ? 'ring-0' : undefined}>
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
                {filters ? (
                  <div className="flex flex-wrap items-center gap-2">{filters}</div>
                ) : null}
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
                total={total}
                searchParams={searchParams}
              />
            </CardContent>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
