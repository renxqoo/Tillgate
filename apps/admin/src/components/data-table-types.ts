import type { ReactNode } from 'react';

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
