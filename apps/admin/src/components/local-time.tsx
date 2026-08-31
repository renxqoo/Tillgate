'use client';

import { fmtDate, fmtDateTime } from '@/lib/formatters';

/**
 * 访客本地时区时间文本（客户端组件）。
 *
 * 契约：服务端时间戳是 UTC ISO 字符串；服务端渲染路径（如 DataTable server
 * component 的 render prop）里 `fmtDateTime`/`fmtDate` 按容器时区（UTC）输出，
 * 访客看到的是 UTC 文本。本组件在浏览器水合时按访客本地时区重新渲染文本，
 * 服务端 HTML 与客户端文本可能不同，必须用 `suppressHydrationWarning` 抑制
 * 水合警告并让客户端文本生效。
 */

interface LocalTimeProps {
  /** UTC ISO 时间字符串；空值/不可解析值交由 fmt 兜底（空值 → '—'，非法值原样） */
  iso: string | null | undefined;
  className?: string;
  /** date = 仅日期（fmtDate）；默认 datetime（fmtDateTime） */
  mode?: 'datetime' | 'date';
}

export function LocalTime({ iso, className, mode = 'datetime' }: LocalTimeProps) {
  const text = mode === 'date' ? fmtDate(iso) : fmtDateTime(iso);
  return (
    <span className={className} suppressHydrationWarning>
      {text}
    </span>
  );
}
