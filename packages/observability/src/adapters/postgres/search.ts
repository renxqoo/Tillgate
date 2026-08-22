/**
 * 列表搜索内部助手:ilike 模式转义——q 中的 %/_/\ 一律按字面匹配
 * (搜索无语法:`foo%bar` 不是通配表达式,是字面串)。
 */
export function escapeLikePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}
