/** 当前页两侧各展示的兄弟页数 */
const SIBLINGS = 2;

/**
 * 生成页码序列（含省略号）：首尾页 + 当前页 ±SIBLINGS；只缺 1 页直接补上，
 * 缺多页才用省略号。纯函数（Pager 与测试共用）。
 */
export function buildPages(page: number, totalPages: number): Array<number | '...'> {
  const maxItems = SIBLINGS * 2 + 5;
  if (totalPages <= maxItems) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const set = new Set<number>([1, totalPages]);
  for (let i = page - SIBLINGS; i <= page + SIBLINGS; i++) {
    if (i >= 1 && i <= totalPages) set.add(i);
  }
  const sorted = [...set].toSorted((a, b) => a - b);
  const out: Array<number | '...'> = [];
  let prev = 0;
  for (const p of sorted) {
    const gap = p - prev;
    if (gap === 2) out.push(prev + 1);
    else if (gap > 2) out.push('...');
    out.push(p);
    prev = p;
  }
  return out;
}
