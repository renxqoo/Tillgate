/**
 * 沿 cause 链探测 PostgreSQL SQLSTATE（5 位数字/大写）。
 * drizzle 把 pg 错误包在 cause 链里——顶层判断会漏，这是全仓唯一实现。
 */
export function pgSqlState(err: Error): string | null {
  let cur: unknown = err;
  while (cur != null && typeof cur === 'object') {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}
