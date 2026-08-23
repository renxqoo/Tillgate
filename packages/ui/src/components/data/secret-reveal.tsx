'use client';

// 密文展示: 默认遮蔽, 可切换明文, 可附复制按钮; 适合 API Key / token / 密钥展示
import { CircleCheckIcon, CopyIcon, EyeIcon, EyeOffIcon } from 'lucide-react';
import * as React from 'react';

import { cn } from '../../cn';
import { useCopy } from '../../hooks/use-copy';
import { Button } from '../primitives/button';

export type SecretRevealProps = {
  value: string;
  // 遮蔽占位符(默认八位圆点)
  mask?: string;
  // 是否附复制按钮(默认 true)
  copy?: boolean;
  revealLabel?: string;
  hideLabel?: string;
  copyLabel?: string;
  copiedLabel?: string;
  copiedDurationMs?: number;
  className?: string;
};

export function SecretReveal({
  value,
  mask = '••••••••',
  copy = true,
  revealLabel = 'Reveal secret',
  hideLabel = 'Hide secret',
  copyLabel = 'Copy secret',
  copiedLabel = 'Copied',
  copiedDurationMs,
  className,
}: SecretRevealProps) {
  const [revealed, setRevealed] = React.useState(false);
  const { copied, copy: copyToClipboard } = useCopy({
    resetAfterMs: copiedDurationMs,
  });

  return (
    <span
      data-slot="secret-reveal"
      data-revealed={revealed}
      className={cn('inline-flex items-center gap-1 font-mono text-sm', className)}
    >
      <span
        data-slot="secret-reveal-value"
        className="min-w-0 truncate"
        // 明文切换仅影响展示, 不广播 live 区域(屏幕用户主动触发, 无需打断)
      >
        {revealed ? value : mask}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={revealed ? hideLabel : revealLabel}
        aria-pressed={revealed}
        onClick={() => setRevealed((current) => !current)}
        className="text-muted-foreground"
      >
        {revealed ? <EyeOffIcon /> : <EyeIcon />}
      </Button>
      {copy ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={copied ? copiedLabel : copyLabel}
          data-copied={copied}
          onClick={() => void copyToClipboard(value)}
          className="text-muted-foreground"
        >
          {copied ? <CircleCheckIcon className="text-success" /> : <CopyIcon />}
        </Button>
      ) : null}
    </span>
  );
}
