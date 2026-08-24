'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { FilterIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../lib/utils';
import { NativeSelect, NativeSelectOption } from '@tillgate/ui';

/**
 * URL 筛选下拉（收敛 users-status / users-enterprise / subscriptions-status /
 * keys-status / logs 状态码等 6 处相同实现）。
 *
 * 选择后把 `param=<value>` 写回当前 URL；选 allValue 时删除该参数。
 * 默认重置到第 1 页（resetPage=false 保留当前页，如 logs 筛选）。
 * 样式与原各页内联 `<select>` 一致（Filter 图标 + appearance-none）。
 */
export function ListFilterSelect({
  param,
  value,
  options,
  allLabel,
  allValue = 'all',
  resetPage = true,
  icon,
  className,
}: {
  /** URL 查询参数名（如 status / enterprise / statusCode） */
  param: string;
  /** 当前值（来自 URL；默认回显 allValue） */
  value: string;
  /** 选项（不含 all 项） */
  options: ReadonlyArray<{ value: string; label: string }>;
  /** all 项文案（缺省用 ui.all 目录文案） */
  allLabel?: string;
  /** 「全部」对应的值（选中即删除参数）；空串表示没有 all 项 */
  allValue?: string;
  /** 切换筛选时是否重置回第 1 页 */
  resetPage?: boolean;
  icon?: ReactNode;
  className?: string;
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const t = useTranslations('ui');
  const all = allLabel ?? t('all');

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = new URLSearchParams(sp.toString());
    if (e.target.value === allValue) next.delete(param);
    else next.set(param, e.target.value);
    if (resetPage) next.delete('page');
    router.push(`?${next.toString()}`);
  }

  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-2.5 top-1/2 z-10 flex size-4 -translate-y-1/2 items-center justify-center text-muted-foreground [&_svg]:size-4">
        {icon ?? <FilterIcon />}
      </span>
      <NativeSelect
        onChange={onChange}
        defaultValue={value || allValue}
        className={cn('w-36', className)}
        selectClassName="pl-9"
      >
        {allValue !== '' ? <NativeSelectOption value={allValue}>{all}</NativeSelectOption> : null}
        {options.map((o) => (
          <NativeSelectOption key={o.value} value={o.value}>
            {o.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  );
}
