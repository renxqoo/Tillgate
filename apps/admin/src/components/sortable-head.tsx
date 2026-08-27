import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';

import { cn } from '@/lib/utils';
import { listHref, type SearchParamsInput } from '@/lib/list-query';
import type { DataTableColumn, DataTableSort } from './data-table-types';

export function SortableHead<Row>({
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
