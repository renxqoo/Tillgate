/** 头像兜底字：取显示名/邮箱前两段首字母（大写，最多 2 字符） */
export function getInitials(name: string): string {
  // filter(Boolean) 保证各段非空串；先取段再判存在，charAt 对索引越界安全返回 ''
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const [first, second] = parts;
  if (first === undefined) return '?';
  if (second === undefined) return first.slice(0, 2).toUpperCase();
  return (first.charAt(0) + second.charAt(0)).toUpperCase();
}
