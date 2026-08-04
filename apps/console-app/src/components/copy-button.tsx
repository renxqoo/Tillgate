'use client';

import { useState, useCallback } from 'react';

/**
 * 复制按钮：点击把指定文本写入剪贴板，显示"已复制"反馈。
 * 失败时（如非 HTTPS / 无权限）回退到选中文本供手动 Ctrl+C。
 */
export function CopyButton({
  text,
  label = '复制',
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 回退：选中文本（非 HTTPS 环境下 navigator.clipboard 不可用）
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // 最终回退：保持选中学用户手动复制
      }
      document.body.removeChild(ta);
    }
  }, [text]);

  return (
    <button
      type="button"
      onClick={onCopy}
      className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs transition-colors hover:bg-muted ${
        copied ? 'border-primary text-primary' : 'text-muted-foreground'
      } ${className ?? ''}`}
      aria-label={copied ? '已复制' : label}
    >
      {copied ? '✓ 已复制' : label}
    </button>
  );
}

/**
 * 可复制文本块：文本 + 行内复制按钮（用于展示 key/secret/id）。
 */
export function CopyableText({
  text,
  mono = true,
  breakAll = false,
}: {
  text: string;
  mono?: boolean;
  breakAll?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 align-middle">
      <code className={`${mono ? 'font-mono' : ''} ${breakAll ? 'break-all' : ''} text-sm`}>{text}</code>
      <CopyButton text={text} />
    </span>
  );
}
