"use client";

import type { ReactNode } from "react";

import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";

/**
 * 状态徽章（收敛各页 25 处内联 `<span className="inline-flex items-center rounded-full
 * bg-emerald-500/15 px-2 py-0.5 text-xs font-medium …">` 与 4 张本地 STATUS_META 表）。
 *
 * 两种形态：
 *   - 默认（胶囊）：与原内联徽章一致 —— Badge + 语义 tone；
 *   - dot（圆点文本）：与渠道状态列一致 —— 无底色、彩点 + 彩字。
 */

export type StatusTone = "success" | "warning" | "danger" | "neutral" | "info" | "accent";

const DOT_CLASS: Record<StatusTone, string> = {
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-destructive",
  neutral: "bg-muted-foreground",
  info: "bg-sky-500",
  accent: "bg-violet-500",
};

const DOT_TEXT_CLASS: Record<StatusTone, string> = {
  success: "text-emerald-700 dark:text-emerald-300",
  warning: "text-amber-700 dark:text-amber-300",
  danger: "text-destructive",
  neutral: "text-muted-foreground",
  info: "text-sky-700 dark:text-sky-300",
  accent: "text-violet-700 dark:text-violet-300",
};

export function StatusPill({
  tone,
  label,
  dot = false,
  className,
  title,
  children,
}: {
  tone: StatusTone;
  label?: ReactNode;
  /** true = 圆点文本形态（无底色） */
  dot?: boolean;
  className?: string;
  /** 悬停提示（如封禁原因） */
  title?: string;
  /** 额外内容（如渠道「（冷却中）」后缀） */
  children?: ReactNode;
}) {
  if (dot) {
    return (
      <span
        title={title}
        className={cn(
          "inline-flex items-center gap-1 text-xs font-medium",
          DOT_TEXT_CLASS[tone],
          className,
        )}
      >
        <span className={cn("size-1.5 rounded-full", DOT_CLASS[tone])} />
        {label}
        {children}
      </span>
    );
  }
  return (
    <Badge variant={tone} title={title} className={cn("gap-1", className)}>
      {label}
      {children}
    </Badge>
  );
}

export interface StatusMeta {
  label: string;
  tone: StatusTone;
}

/**
 * 定义状态元数据表（label + 语义 tone），返回带兜底的 getter。
 *
 *   const CHANNEL_STATUS = defineStatusMeta({
 *     0: { label: "启用", tone: "success" },
 *     1: { label: "降级", tone: "warning" },
 *   });
 *   const meta = CHANNEL_STATUS.get(channel.status); // 未命中走 fallback（默认 未知/neutral）
 */
export function defineStatusMeta<T extends PropertyKey>(
  meta: Record<T, StatusMeta>,
  fallback: StatusMeta = { label: "未知", tone: "neutral" },
) {
  return {
    get(key: T | number | string): StatusMeta {
      return meta[key as T] ?? fallback;
    },
  };
}
