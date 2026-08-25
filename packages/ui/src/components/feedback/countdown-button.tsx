'use client';

// 倒计时按钮：冷却截止时刻（epoch ms）前禁用并显示剩余秒数——验证码「重发」
// 场景通用件（发送动作与成败反馈由调用方编排，本件只管冷却态呈现）。
import { Button } from '../primitives/button';
import { useCountdown } from '../../hooks/use-countdown';

export type CountdownButtonProps = Omit<React.ComponentProps<typeof Button>, 'children'> & {
  /** 冷却截止时刻（epoch ms；null 或已过期 = 可点击） */
  cooldownUntil?: number | null;
  /** 可点击时的文案 */
  label: React.ReactNode;
  /** 冷却中的文案（入参为剩余整秒；缺省显示 `${seconds}s`） */
  countdownLabel?: (seconds: number) => React.ReactNode;
};

export function CountdownButton({
  cooldownUntil,
  label,
  countdownLabel,
  disabled,
  ...props
}: CountdownButtonProps) {
  const { remainingSec, active } = useCountdown(cooldownUntil);
  return (
    <Button
      type="button"
      disabled={disabled || active}
      data-slot="countdown-button"
      data-counting={active}
      {...props}
    >
      {active ? (countdownLabel ? countdownLabel(remainingSec) : `${remainingSec}s`) : label}
    </Button>
  );
}
