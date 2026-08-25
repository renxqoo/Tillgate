// CountdownButton 渲染规格：冷却截止时刻驱动——未激活可点显示 label；
// 冷却中禁用并显示剩余整秒；到期自动恢复（fake timers 驱动跨秒）。
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CountdownButton } from '../../src/index';

afterEach(() => {
  vi.useRealTimers();
});

describe('CountdownButton', () => {
  it('label 呈现与点击透传（无冷却）', async () => {
    const onClick = vi.fn();
    render(<CountdownButton label="Send code" cooldownUntil={null} onClick={onClick} />);
    const btn = screen.getByRole('button', { name: 'Send code' });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('冷却中：禁用并显示剩余秒（countdownLabel）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T12:00:00Z'));
    render(
      <CountdownButton
        label="Send code"
        cooldownUntil={Date.now() + 60_000}
        countdownLabel={(s) => `Resend in ${s}s`}
      />,
    );
    const btn = screen.getByRole('button', { name: 'Resend in 60s' });
    expect(btn).toBeDisabled();
  });

  it('到期自动恢复：跨过截止时刻后回到可点击 label', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T12:00:00Z'));
    const onClick = vi.fn();
    render(
      <CountdownButton
        label="Send code"
        cooldownUntil={Date.now() + 3_000}
        countdownLabel={(s) => `${s}s`}
        onClick={onClick}
      />,
    );
    expect(screen.getByRole('button', { name: '3s' })).toBeDisabled();
    act(() => {
      vi.advanceTimersByTime(3_100);
    });
    const btn = screen.getByRole('button', { name: 'Send code' });
    expect(btn).toBeEnabled();
    // fake timers 下 userEvent 会等真实定时器——用同步 fireEvent
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
