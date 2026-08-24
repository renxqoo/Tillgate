'use client';

import { CircleCheckIcon, CopyIcon } from 'lucide-react';

import { useCopy } from '@tillgate/ui';

interface Props {
  value: string;
  label: string;
  copiedLabel?: string;
  className?: string;
}

/** 黑色胶囊复制按钮（营销页专用样式，覆盖 ui CopyButton 的图标形态） */
export function CopyPill({ value, label, copiedLabel, className }: Props) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      aria-label={copied ? (copiedLabel ?? label) : label}
      onClick={() => void copy(value)}
      className={className}
    >
      {copied ? <CircleCheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
      {copied ? (copiedLabel ?? label) : label}
    </button>
  );
}
