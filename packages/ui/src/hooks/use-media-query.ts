// 媒体查询 hook: SSR/首帧返回 undefined(由调用方决定降级语义), 挂载后始终返回实时布尔值
import * as React from 'react';

export function useMediaQuery(query: string): boolean | undefined {
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    [query],
  );

  // getServerSnapshot 显式返回 undefined: SSR/水合首帧语义与 hook 契约一致(由调用方降级)
  return React.useSyncExternalStore<boolean | undefined>(
    subscribe,
    () => window.matchMedia(query).matches,
    // eslint-disable-next-line unicorn/no-useless-undefined -- getServerSnapshot 需显式返回 undefined(非省略)：SSR/水合首帧契约由调用方按 undefined 降级，不能用 null/false 替代
    () => undefined,
  );
}
