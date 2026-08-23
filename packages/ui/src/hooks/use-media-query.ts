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

  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => undefined,
  );
}
