import * as React from "react";

/** 当前页两侧各展示的兄弟页数。 */
const SIBLINGS = 2;

/** 生成页码序列（含省略号）：首尾页 + 当前页 ±SIBLINGS；只缺 1 页时直接补上，缺多页才用 "..."。 */
function buildPages(page: number, totalPages: number): Array<number | "..."> {
  const maxItems = SIBLINGS * 2 + 5; // 首 + 尾 + 当前 ±2 + 2 个省略号
  if (totalPages <= maxItems) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const set = new Set<number>([1, totalPages]);
  for (let i = page - SIBLINGS; i <= page + SIBLINGS; i++) {
    if (i >= 1 && i <= totalPages) set.add(i);
  }
  const sorted = [...set].sort((a, b) => a - b);
  const out: Array<number | "..."> = [];
  let prev = 0;
  for (const p of sorted) {
    const gap = p - prev;
    if (gap === 2) out.push(prev + 1); // 只缺 1 页 → 直接显示该页，不用省略号
    else if (gap > 2) out.push("...");
    out.push(p);
    prev = p;
  }
  return out;
}

/**
 * 通用分页条（框架无关，服务端/客户端通用），支持点击页号。
 * 传入当前 query 参数（searchParams），翻页时只改 page、保留其余筛选条件。
 */
export function Pager({
  page,
  totalPages,
  total,
  searchParams = {},
  className,
}: {
  page: number;
  totalPages: number;
  /** 可选：总条数（显示「共 N 条」） */
  total?: number;
  /** 当前 query 参数（page 会被覆盖；空值跳过） */
  searchParams?: Record<string, string | string[] | undefined>;
  className?: string;
}) {
  function makeHref(target: number): string {
    const sp = new URLSearchParams();
    for (const [key, value] of Object.entries(searchParams)) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value)) {
        for (const v of value) sp.append(key, v);
      } else {
        sp.set(key, value);
      }
    }
    sp.set("page", String(target));
    const qs = sp.toString();
    return qs ? `?${qs}` : "";
  }

  const arrowBase = "rounded-md border px-2.5 py-1";
  const pageBase = "min-w-8 rounded-md border px-2 py-1 text-center";
  const active = "hover:bg-muted";
  const disabled = "pointer-events-none opacity-50";

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground ${className ?? ""}`}
    >
      <span>
        第 {page} / {totalPages} 页{total !== undefined ? ` · 共 ${total} 条` : ""}
      </span>
      <div className="flex items-center gap-1">
        <a
          href={makeHref(page - 1)}
          aria-disabled={page <= 1}
          className={`${arrowBase} ${page <= 1 ? disabled : active}`}
        >
          上一页
        </a>
        {buildPages(page, totalPages).map((p, i) =>
          p === "..." ? (
            <span key={`e${i}`} className="px-1.5 text-muted-foreground/60">
              …
            </span>
          ) : p === page ? (
            <span
              key={p}
              className={`${pageBase} border-primary bg-primary font-medium text-primary-foreground`}
            >
              {p}
            </span>
          ) : (
            <a key={p} href={makeHref(p)} className={`${pageBase} ${active}`}>
              {p}
            </a>
          ),
        )}
        <a
          href={makeHref(page + 1)}
          aria-disabled={page >= totalPages}
          className={`${arrowBase} ${page >= totalPages ? disabled : active}`}
        >
          下一页
        </a>
      </div>
    </div>
  );
}
