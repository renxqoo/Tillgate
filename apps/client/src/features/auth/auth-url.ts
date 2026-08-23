/**
 * 登录/注册页查询参数白名单清理（URL 不承载登录信息）。
 *
 * 凭证（email/password/令牌等）一旦进查询串，会留痕于地址栏、浏览器历史、
 * 反代 access log 与分享渠道——登录族页面结构上不接受任何白名单外的
 * 查询参数：命中即重定向到仅保留白名单参数的干净 URL。
 * 白名单制（而非黑名单）是刻意设计：新增参数必须显式登记，未登记的一律剥除。
 */
export type SearchParamsLike = Record<string, string | string[] | undefined>;

/**
 * 计算清理后的 URL。
 * @returns 需要清理时返回干净 URL（仅含白名单参数）；无需清理返回 null
 * （null = 原样渲染，调用方不得重定向，避免循环）。
 */
export function stripAuthParams(
  path: string,
  params: SearchParamsLike,
  allowed: readonly string[],
): string | null {
  const kept = new URLSearchParams();
  let changed = false;
  for (const [key, value] of Object.entries(params)) {
    if (allowed.includes(key)) {
      const first = Array.isArray(value) ? value[0] : value;
      if (first !== undefined && first !== '') kept.set(key, first);
    } else {
      changed = true;
    }
  }
  if (!changed) return null;
  const query = kept.toString();
  return query ? `${path}?${query}` : path;
}
