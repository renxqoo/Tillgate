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
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { SearchIcon, XIcon } from 'lucide-react';

import { Pager } from '@/components/pager';
import { listHref, type SearchParamsInput } from '../lib/list-query';

/**
 * 统一「列表搜索页」骨架（admin / client 所有列表页共用）：
 *
 *   页头（图标 + 标题 + 共 N 条 | actions 插槽）
 *   aboveList 插槽（可选，页头与列表面板之间的额外内容）
 *   ListPanel（搜索表单 + filters 插槽 | 表格 children | 分页 Pager）
 *
 * - 搜索是原生 GET form：提交后整组参数进 URL；除 q/page 外的现有筛选
 *   以 hidden input 保留，因此搜索永远回到第 1 页且不丢筛选。
 * - children 放 DataTable；children 传 null 且无 error 时整个列表面板不渲染
 *   （无数据隐藏列表，如兑换记录）；分页条仅在超过一页（total > pageSize）时渲染。
 * - 无 "use client"，server page 直接用；插槽里可以放任意 client 组件。
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
  /** 列表总数（页头「共 N 条」） */
  total?: number;
  /** 计数单位词；缺省用 ui.itemsUnit 目录文案 */
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
  /** 页头与列表面板之间插入的内容（如充值码页的兑换表单卡） */
  aboveList?: ReactNode;
  /** 非空时替代 children 展示错误（页面 fetch 失败文案） */
  error?: string | null;
  children: ReactNode;
  /** 传 page/pageSize 且 total 超过一页（total > pageSize）时渲染分页条 */
  page?: number;
  pageSize?: number;
  /**
   * 内容不套 Card 容器、直接平铺——非列表形态的页面（操练场/邀请/账单等）用。
   * 子内容需自带边框容器（Card / rounded-lg border）；搜索/筛选/分页插槽不生效
   */
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

  let listContent: ReactNode = null;
  if (error || children) {
    if (unbordered) {
      listContent = error ? (
        <p className="p-8 text-center text-sm text-destructive">{error}</p>
      ) : (
        children
      );
    } else {
      listContent = (
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
          {page !== undefined &&
          pageSize !== undefined &&
          total !== undefined &&
          total > pageSize ? (
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
  }

  return (
    <div className="flex flex-col gap-4 md:gap-6">
      <PageHeader title={title} description={descriptionLine} icon={icon} actions={actions} />

      {aboveList}

      {listContent}
    </div>
  );
}
