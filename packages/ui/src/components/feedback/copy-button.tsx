// 复制按钮: 点击写入剪贴板并短暂切换为"已复制"状态
import { CircleCheckIcon, CopyIcon } from 'lucide-react';

import { useCopy } from '../../hooks/use-copy';
import { Button } from '../primitives/button';

export type CopyButtonProps = Omit<React.ComponentProps<typeof Button>, 'onClick' | 'children'> & {
  value: string;
  copyLabel?: string;
  copiedLabel?: string;
  copiedDurationMs?: number;
};

export function CopyButton({
  value,
  copyLabel = 'Copy',
  copiedLabel = 'Copied',
  copiedDurationMs,
  variant = 'ghost',
  size = 'icon-sm',
  className,
  ...props
}: CopyButtonProps) {
  const { copied, copy } = useCopy({ resetAfterMs: copiedDurationMs });

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      aria-label={copied ? copiedLabel : copyLabel}
      data-slot="copy-button"
      data-copied={copied}
      onClick={() => void copy(value)}
      className={className}
      {...props}
    >
      {copied ? <CircleCheckIcon className="text-success" /> : <CopyIcon />}
    </Button>
  );
}
