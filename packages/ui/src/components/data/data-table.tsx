// 通用数据表: 纯受控展示——数据/排序状态由调用方持有(服务端排序友好), 组件只负责
// 渲染与交互回调; 加载骨架与空态内置。列定义用 cell 渲染函数保持完全的展示自由。
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon } from 'lucide-react';
import type * as React from 'react';

import { cn } from '../../cn';
import { Button } from '../primitives/button';
import { Skeleton } from '../primitives/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table';

export type DataTableSortState = {
  key: string;
  direction: 'asc' | 'desc';
};

export type DataTableColumn<Row> = {
  key: string;
  header: React.ReactNode;
  align?: 'left' | 'right' | 'center';
  // sortable 且提供 onSortChange 时表头渲染为三态切换按钮(asc → desc → 清除)
  sortable?: boolean;
  cell: (row: Row, index: number) => React.ReactNode;
  headerClassName?: string;
  cellClassName?: string;
};

export type DataTableProps<Row> = {
  columns: DataTableColumn<Row>[];
  rows: readonly Row[];
  // 行 key 提取必须显式注入(不静默退化为数组下标)
  rowKey: (row: Row, index: number) => React.Key;
  sort?: DataTableSortState | null;
  onSortChange?: (next: DataTableSortState | null) => void;
  loading?: boolean;
  // 加载态骨架行数(默认 5)
  loadingRowCount?: number;
  // 空态内容(默认内置英文空态)
  empty?: React.ReactNode;
  className?: string;
};

const ALIGN_CLASS: Record<NonNullable<DataTableColumn<unknown>['align']>, string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
};

function nextSortState(
  columnKey: string,
  current: DataTableSortState | null | undefined,
): DataTableSortState | null {
  if (!current || current.key !== columnKey) {
    return { key: columnKey, direction: 'asc' };
  }
  if (current.direction === 'asc') {
    return { key: columnKey, direction: 'desc' };
  }
  return null;
}

function sortIndicator(
  column: Pick<DataTableColumn<unknown>, 'key' | 'sortable'>,
  sort: DataTableSortState | null | undefined,
): React.ReactNode {
  if (!column.sortable) {
    return null;
  }
  if (sort?.key === column.key) {
    return sort.direction === 'asc' ? (
      <ArrowUpIcon className="size-3.5" />
    ) : (
      <ArrowDownIcon className="size-3.5" />
    );
  }
  return <ChevronsUpDownIcon className="size-3.5 text-muted-foreground" />;
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  sort,
  onSortChange,
  loading = false,
  loadingRowCount = 5,
  empty,
  className,
}: DataTableProps<Row>) {
  const skeletonRows = Math.max(1, loadingRowCount);

  return (
    <div data-slot="data-table" className={cn('w-full', className)}>
      <Table className="[&_tr]:border-border/60">
        <TableHeader className="bg-card">
          <TableRow className="hover:bg-transparent">
            {columns.map((column) => {
              const alignClass = ALIGN_CLASS[column.align ?? 'left'];
              const sortable = column.sortable && onSortChange !== undefined;
              return (
                <TableHead
                  key={column.key}
                  data-column={column.key}
                  aria-sort={
                    column.sortable
                      ? sort?.key === column.key
                        ? sort.direction === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                      : undefined
                  }
                  className={cn(
                    'first:pl-4 last:pr-4',
                    column.key === 'actions' && 'w-16 text-center',
                    alignClass,
                    column.headerClassName,
                  )}
                >
                  {column.key === 'actions' ? (
                    column.header
                  ) : sortable ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="-ms-1 font-medium"
                      onClick={() => onSortChange?.(nextSortState(column.key, sort))}
                    >
                      {column.header}
                      {sortIndicator(column, sort)}
                    </Button>
                  ) : (
                    column.header
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            Array.from({ length: skeletonRows }, (_, rowIndex) => (
              <TableRow key={`skeleton-${rowIndex}`} data-slot="data-table-skeleton-row">
                {columns.map((column) => (
                  <TableCell
                    key={column.key}
                    className={cn(
                      'first:pl-4 last:pr-4',
                      column.key === 'actions' && 'w-16 text-center',
                      ALIGN_CLASS[column.align ?? 'left'],
                      column.cellClassName,
                    )}
                  >
                    <Skeleton className="h-4 w-full max-w-32" />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-24 text-center">
                {empty ?? 'No data'}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row, rowIndex) => (
              <TableRow key={rowKey(row, rowIndex)}>
                {columns.map((column) => (
                  <TableCell
                    key={column.key}
                    className={cn(
                      'first:pl-4 last:pr-4',
                      column.key === 'actions' && 'w-16 text-center',
                      ALIGN_CLASS[column.align ?? 'left'],
                      column.cellClassName,
                    )}
                  >
                    {column.cell(row, rowIndex)}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
