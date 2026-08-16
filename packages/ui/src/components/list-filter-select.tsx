"use client";

import { useRouter, useSearchParams } from "next/navigation";

import { FilterIcon } from "lucide-react";

import { cn } from "../lib/utils";

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
  allLabel = "全部",
  allValue = "all",
  resetPage = true,
  className,
}: {
  /** URL 查询参数名（如 status / enterprise / statusCode） */
  param: string;
  /** 当前值（来自 URL；默认回显 allValue） */
  value: string;
  /** 选项（不含 all 项） */
  options: ReadonlyArray<{ value: string; label: string }>;
  /** all 项文案 */
  allLabel?: string;
  /** 「全部」对应的值（选中即删除参数）；空串表示没有 all 项 */
  allValue?: string;
  /** 切换筛选时是否重置回第 1 页 */
  resetPage?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const sp = useSearchParams();

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = new URLSearchParams(sp.toString());
    if (e.target.value === allValue) next.delete(param);
    else next.set(param, e.target.value);
    if (resetPage) next.delete("page");
    router.push(`?${next.toString()}`);
  }

  return (
    <div className="relative">
      <FilterIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <select
        onChange={onChange}
        defaultValue={value || allValue}
        className={cn(
          "h-9 w-32 appearance-none rounded-md border border-input bg-transparent pl-9 pr-3 text-sm shadow-xs focus-visible:ring-1 focus-visible:ring-ring",
          className,
        )}
      >
        {allValue !== "" ? <option value={allValue}>{allLabel}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
