import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';

import { cn } from '@/lib/utils';
import { listHref, type SearchParamsInput } from '@/lib/list-query';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@tillgate/ui';

/**
 * 统一列表表格（admin / client 所有列表页共用）。
 *
 * - 不带 "use client"：server page 直接渲染（render prop 在服务端执行），
 *   client 组件也可导入使用（整棵进客户端包）。
 * - 排序走 URL（?sort_by=&order=），点击表头切换方向并回到第 1 页；
 *   searchParams 未传时 sortable 降级为纯展示。
 * - 数据获取/分页在页面层完成，本组件只负责呈现。
 */

export interface DataTableSort {
  sortBy?: string;
  order: 'asc' | 'desc';
}

export interface DataTableColumn<Row> {
  /** 列标识；未提供 render 时取 row[key] 作为单元格内容 */
  key: string;
  header: ReactNode;
  /** 点击表头排序（需要传 searchParams 才会渲染链接） */
  sortable?: boolean;
  /** 对应接口 sort_by 白名单字段名，默认取 key */
  sortBy?: string;
  align?: 'left' | 'right' | 'center';
  className?: string;
  headerClassName?: string;
  render?: (row: Row, index: number) => ReactNode;
}

const ALIGN_CLASS: Record<NonNullable<DataTableColumn<unknown>['align']>, string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
};

function SortableHead<Row>({
  column,
  sort,
  searchParams,
}: {
  column: DataTableColumn<Row>;
  sort?: DataTableSort;
  searchParams?: SearchParamsInput;
}) {
  const field = column.sortBy ?? column.key;
  const active = sort?.sortBy === field;
  const nextOrder = active && sort.order === 'asc' ? 'desc' : 'asc';
  const href = listHref(searchParams ?? {}, {
    sort_by: field,
    order: nextOrder,
    page: 1,
  });
  let Icon = ArrowUpDown;
  if (active) Icon = sort.order === 'asc' ? ArrowUp : ArrowDown;
  return (
    <a
      href={href}
      className={cn(
        'inline-flex items-center gap-1 hover:text-foreground',
        active && 'text-foreground',
      )}
    >
      {column.header}
      <Icon
        className={cn('size-3.5', active ? 'text-primary' : 'text-muted-foreground/60')}
        aria-hidden
      />
    </a>
  );
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  sort,
  searchParams,
  empty,
  className,
}: {
  columns: DataTableColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row, index: number) => string | number;
  /** 当前排序状态（来自 URL sort_by/order） */
  sort?: DataTableSort;
  /** 当前页完整 query 参数（排序链接保留其余筛选） */
  searchParams?: SearchParamsInput;
  /** 空态文案；缺省用 ui.empty 目录文案 */
  empty?: ReactNode;
  className?: string;
}) {
  const t = useTranslations('ui');
  /** dev-only：行 key 重复自诊断（React 只给通用警告，这里指出具体重复值与索引） */
  const dupKeys =
    process.env.NODE_ENV !== 'production'
      ? (() => {
          const seen = new Map<string | number, number>();
          const dups = new Set<string | number>();
          rows.forEach((row, i) => {
            const k = rowKey(row, i);
            if (seen.has(k)) dups.add(k);
            else seen.set(k, i);
          });
          return dups;
        })()
      : new Set<string | number>();

  return (
    <Table className={cn('[&_tr]:border-border/60', className)}>
      {dupKeys.size > 0 && (
        <caption className="mt-2 rounded border border-destructive/40 bg-destructive/10 p-2 text-left text-xs text-destructive">
          DataTable diagnostics: duplicate row keys {JSON.stringify([...dupKeys])} (rowKey must
          return unique values)
        </caption>
      )}
      <TableHeader className="bg-card">
        <TableRow className="hover:bg-transparent">
          {columns.map((column) => (
            <TableHead
              key={column.key}
              aria-sort={(() => {
                if (!column.sortable) return;
                if (sort?.sortBy !== (column.sortBy ?? column.key)) return 'none';
                return sort.order === 'asc' ? 'ascending' : 'descending';
              })()}
              className={cn(
                'first:pl-4 last:pr-4',
                column.key === 'actions' && 'w-16 text-center',
                column.align && ALIGN_CLASS[column.align],
                column.headerClassName,
              )}
            >
              {(() => {
                if (column.key === 'actions') return column.header;
                if (column.sortable && searchParams) {
                  return <SortableHead column={column} sort={sort} searchParams={searchParams} />;
                }
                return column.header;
              })()}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
              {empty ?? t('empty')}
            </TableCell>
          </TableRow>
        ) : (
          rows.map((row, index) => (
            <TableRow key={rowKey(row, index)}>
              {columns.map((column) => (
                <TableCell
                  key={column.key}
                  className={cn(
                    'first:pl-4 last:pr-4',
                    column.key === 'actions' && 'w-16 text-center',
                    column.align && ALIGN_CLASS[column.align],
                    column.className,
                  )}
                >
                  {column.render
                    ? column.render(row, index)
                    : ((row as Record<string, unknown>)[column.key] as ReactNode)}
                </TableCell>
              ))}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
