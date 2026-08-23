// 剪贴板 hook: 复制成功后短暂保持 copied=true 供按钮呈现"已复制"反馈
import * as React from 'react';

export type UseCopyResult = {
  copied: boolean;
  // 写入剪贴板; 非安全上下文(无 navigator.clipboard)返回 false, 不抛错
  copy: (text: string) => Promise<boolean>;
};

export function useCopy(options?: { resetAfterMs?: number }): UseCopyResult {
  const resetAfterMs = options?.resetAfterMs ?? 2000;
  const [copied, setCopied] = React.useState(false);
  const timerRef = React.useRef<number | undefined>(undefined);

  // 卸载时清掉未触发的复位定时器, 避免 setState 打到已卸载组件
  React.useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const copy = React.useCallback(
    async (text: string) => {
      if (!navigator.clipboard) {
        return false;
      }
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), resetAfterMs);
      return true;
    },
    [resetAfterMs],
  );

  return { copied, copy };
}
