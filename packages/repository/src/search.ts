/**
 * 列表搜索内部助手：ilike 模式转义——q 中的 %/_/\ 一律按字面匹配
 * （搜索无语法：`foo%bar` 不是通配表达式，是字面串）。仅供本包仓储使用，
 * 白名单排序校验等边界语义在 app 层。
 */
export function escapeLikePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}
