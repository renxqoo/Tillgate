import * as React from 'react';

import { pagerHref } from '../../lib/pager-href';

/** 当前页两侧各展示的兄弟页数。 */
const SIBLINGS = 2;

/** 生成页码序列（含省略号）：首尾页 + 当前页 ±SIBLINGS；只缺 1 页时直接补上，缺多页才用 "..."。 */
function buildPages(page: number, totalPages: number): Array<number | '...'> {
  const maxItems = SIBLINGS * 2 + 5; // 首 + 尾 + 当前 ±2 + 2 个省略号
  if (totalPages <= maxItems) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const set = new Set<number>([1, totalPages]);
  for (let i = page - SIBLINGS; i <= page + SIBLINGS; i++) {
    if (i >= 1 && i <= totalPages) set.add(i);
  }
  const sorted = [...set].sort((a, b) => a - b);
  const out: Array<number | '...'> = [];
  let prev = 0;
  for (const p of sorted) {
    const gap = p - prev;
    if (gap === 2)
      out.push(prev + 1); // 只缺 1 页 → 直接显示该页，不用省略号
    else if (gap > 2) out.push('...');
    out.push(p);
    prev = p;
  }
  return out;
}

/**
 * 通用分页条（框架无关，服务端/客户端通用），支持点击页号。
 *
 * 两种驱动模式：
 *   - URL 模式（默认）：传 searchParams，翻页渲染 <a href>（只改 page、保留其余筛选）——
 *     服务端列表页用；
 *   - 受控模式：传 onPageChange，翻页渲染 <button> 回调（内存分页/客户端筛选切片——
 *     如模型市场：数据一次性下发，翻页不走路由）。
 * 总页数 <= 1（数据不足一页）时整条不渲染——所有列表页统一。
 */
export function Pager({
  page,
  totalPages,
  total,
  searchParams = {},
  pageKey = 'page',
  onPageChange,
  className,
}: {
  page: number;
  totalPages: number;
  /** 可选：总条数（显示「共 N 条」） */
  total?: number;
  /** 当前 query 参数（pageKey 会被覆盖；空值跳过）；URL 模式必传 */
  searchParams?: Record<string, string | string[] | undefined>;
  /**
   * 页码参数名。单列表页用默认 page；同页多列表（如用户详情的流水/审计）
   * 必须各用独立键（tpage/apage）——此前硬编码 page，页面读 tpage 导致
   * 点击分页参数名对不上、翻页无效。
   */
  pageKey?: string;
  /** 受控模式：提供时翻页走回调（button），不渲染链接；searchParams 被忽略 */
  onPageChange?: (page: number) => void;
  className?: string;
}) {
  const makeHref = (target: number): string => pagerHref(searchParams, pageKey, target);
  /** 页码目标合法性（受控模式同样要拦首尾越界点击） */
  const reachable = (target: number): boolean => target >= 1 && target <= totalPages && target !== page;

  if (totalPages <= 1) return null;

  const arrowBase = 'rounded-md border px-2.5 py-1';
  const pageBase = 'min-w-8 rounded-md border px-2 py-1 text-center';
  const active = 'hover:bg-muted';
  const disabled = 'pointer-events-none opacity-50';

  /** 链接（URL 模式）或按钮（受控模式）——同一外观，仅交互载体不同 */
  const Nav = ({ target, children, arrow }: { target: number; children: React.ReactNode; arrow?: boolean }) =>
    onPageChange ? (
      <button
        type="button"
        onClick={() => reachable(target) && onPageChange(target)}
        aria-disabled={!reachable(target)}
        className={`${arrow ? arrowBase : pageBase} ${reachable(target) ? active : disabled}`}
      >
        {children}
      </button>
    ) : (
      <a
        href={makeHref(target)}
        aria-disabled={!reachable(target)}
        className={`${arrow ? arrowBase : pageBase} ${reachable(target) ? active : disabled}`}
      >
        {children}
      </a>
    );

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground ${className ?? ''}`}
    >
      <span>
        第 {page} / {totalPages} 页{total !== undefined ? ` · 共 ${total.toLocaleString()} 条` : ''}
      </span>
      <div className="flex items-center gap-1">
        <Nav target={page - 1} arrow>
          上一页
        </Nav>
        {buildPages(page, totalPages).map((p, i) =>
          p === '...' ? (
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
            <Nav key={p} target={p}>
              {p}
            </Nav>
          ),
        )}
        <Nav target={page + 1} arrow>
          下一页
        </Nav>
      </div>
    </div>
  );
}
