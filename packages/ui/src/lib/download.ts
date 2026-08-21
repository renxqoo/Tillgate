/**
 * 浏览器端文件下载工具（client-only，调用处均在事件回调里）。
 */

/**
 * TSV 导出（收敛 admin users-export / client export-keys 两份相同实现）。
 *
 *   downloadTsv("users", [
 *     ["id", "subject", "email"],
 *     [String(u.id), u.subject, u.email ?? ""],
 *   ]);
 *
 * 文件名：`<name>-<yyyy-mm-dd>.tsv`。
 */
export function downloadTsv(
  name: string,
  rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>,
): void {
  const lines = rows.map((row) => row.join("\t"));
  const blob = new Blob([lines.join("\n")], { type: "text/tab-separated-values" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.tsv`;
  a.click();
  URL.revokeObjectURL(url);
}
