'use client';

// 倒计时 hook：以「截止时刻」(epoch ms) 驱动——跨组件重挂载/重开弹窗只要持有
// 同一时刻值，剩余秒数即连续；冷却期内每秒重渲染，到期自动停止计时。
import { useEffect, useState } from 'react';

export interface UseCountdownResult {
  /** 剩余整秒（未激活或已到期 = 0） */
  remainingSec: number;
  /** 冷却进行中（true = 期间应禁用触发动作） */
  active: boolean;
}

export function useCountdown(cooldownUntil: number | null | undefined): UseCountdownResult {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (cooldownUntil == null || cooldownUntil <= Date.now()) return;
    const id = setInterval(() => {
      const now = Date.now();
      if (now >= cooldownUntil) clearInterval(id);
      setNowMs(now);
    }, 1000);
    return () => clearInterval(id);
  }, [cooldownUntil]);

  const remainingSec =
    cooldownUntil == null ? 0 : Math.max(0, Math.ceil((cooldownUntil - nowMs) / 1000));
  return { remainingSec, active: remainingSec > 0 };
}
