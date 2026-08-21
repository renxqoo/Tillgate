"use client";

import type { ReactNode } from "react";

import { CopyButton } from "./shell/copy-button";

/**
 * 「凭据仅显示一次」面板（收敛 3 处：创建 Key 明文、应用创建凭据、轮换/生成新码）。
 *
 * 绿色提示面板 + 标题行（标题 + 复制按钮）+ children（凭据内容）。
 *
 *   <SecretReveal title="明文 Key（请立即复制并安全保存）" copy={revealedKey}>
 *     <code className="block break-all font-mono text-sm">{revealedKey}</code>
 *   </SecretReveal>
 */
export function SecretReveal({
  title,
  copy,
  copyLabel,
  children,
}: {
  /** 面板标题（绿色小字） */
  title: ReactNode;
  /** 复制到剪贴板的内容；不传则不渲染复制按钮 */
  copy?: string;
  copyLabel?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-3 rounded-md bg-emerald-500/10 p-4 ring-1 ring-emerald-500/30">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-emerald-700 dark:text-emerald-300">{title}</p>
        {copy !== undefined ? <CopyButton text={copy} label={copyLabel} /> : null}
      </div>
      {children}
    </div>
  );
}
