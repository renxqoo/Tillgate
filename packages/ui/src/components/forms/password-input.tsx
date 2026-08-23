'use client';

// 密码输入框: Input + 显隐切换按钮; 外观/尺寸完全继承 Input, 适合与 Field 组合
import * as React from 'react';
import { EyeIcon, EyeOffIcon } from 'lucide-react';

import { cn } from '../../cn';
import { Button } from '../primitives/button';
import { Input } from './input';

export type PasswordInputProps = Omit<React.ComponentProps<typeof Input>, 'type'> & {
  // 显/隐按钮的 aria-label 文案, 默认英文, 可注入本地化
  showLabel?: string;
  hideLabel?: string;
};

export function PasswordInput({
  className,
  showLabel = 'Show password',
  hideLabel = 'Hide password',
  ...props
}: PasswordInputProps) {
  const [revealed, setRevealed] = React.useState(false);

  return (
    <div data-slot="password-input" className={cn('relative', className)}>
      <Input type={revealed ? 'text' : 'password'} className="pe-9" {...props} />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={revealed ? hideLabel : showLabel}
        aria-pressed={revealed}
        onClick={() => setRevealed((current) => !current)}
        className="absolute end-1 top-1/2 -translate-y-1/2 text-muted-foreground"
      >
        {revealed ? <EyeOffIcon /> : <EyeIcon />}
      </Button>
    </div>
  );
}
