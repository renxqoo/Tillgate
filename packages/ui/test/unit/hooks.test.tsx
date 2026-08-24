import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCopy } from '../../src/hooks/use-copy';
import { useIsMobile } from '../../src/hooks/use-mobile';
import { useMediaQuery } from '../../src/hooks/use-media-query';

// 可控 matchMedia 桩: set() 触发所有已注册监听
type MediaState = Record<string, boolean>;
function installMatchMedia(initial: MediaState) {
  const state: MediaState = { ...initial };
  const listeners = new Set<() => void>();
  window.matchMedia = ((query: string) =>
    ({
      matches: state[query] ?? false,
      media: query,
      onchange: null,
      addEventListener: (_type: string, cb: () => void) => {
        listeners.add(cb);
      },
      removeEventListener: (_type: string, cb: () => void) => {
        listeners.delete(cb);
      },
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
  return {
    set(query: string, value: boolean) {
      state[query] = value;
      listeners.forEach((listener) => listener());
    },
  };
}

describe('useMediaQuery', () => {
  it('首帧 undefined, 挂载后反映 matches', () => {
    const media = installMatchMedia({ '(min-width: 64rem)': true });
    const { result } = renderHook(() => useMediaQuery('(min-width: 64rem)'));
    expect(result.current).toBe(true);
    act(() => media.set('(min-width: 64rem)', false));
    expect(result.current).toBe(false);
  });

  it('未匹配查询返回 false', () => {
    installMatchMedia({});
    const { result } = renderHook(() => useMediaQuery('(max-width: 767px)'));
    expect(result.current).toBe(false);
  });

  it('卸载后监听被移除(不再触发 setState)', () => {
    const media = installMatchMedia({});
    const { result, unmount } = renderHook(() => useMediaQuery('(a)'));
    unmount();
    // 具名化媒询触发动作: 压平 describe→it→expect→act 的四层回调嵌套
    const fireMediaChange = () => media.set('(a)', true);
    expect(() => act(fireMediaChange)).not.toThrow();
    expect(result.current).toBe(false);
  });
});

describe('useIsMobile', () => {
  it('移动断点匹配时为 true', () => {
    installMatchMedia({ '(max-width: 767px)': true });
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });

  it('默认(不匹配)为 false, 与首帧语义一致', () => {
    installMatchMedia({});
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });
});

describe('useCopy', () => {
  const writeText = vi.fn(async (_text: string) => {});

  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
  });

  it('复制成功后 copied 短暂为 true 并复位', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useCopy());
      expect(result.current.copied).toBe(false);
      await act(async () => {
        await result.current.copy('hello');
      });
      expect(writeText).toHaveBeenCalledWith('hello');
      expect(result.current.copied).toBe(true);
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(result.current.copied).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resetAfterMs 注入生效', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useCopy({ resetAfterMs: 100 }));
      await act(async () => {
        await result.current.copy('x');
      });
      act(() => {
        vi.advanceTimersByTime(99);
      });
      expect(result.current.copied).toBe(true);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(result.current.copied).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('连续复制会重置复位计时', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useCopy());
      await act(async () => {
        await result.current.copy('a');
      });
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      await act(async () => {
        await result.current.copy('b');
      });
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      expect(result.current.copied).toBe(true);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(result.current.copied).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('非安全上下文(无 clipboard)返回 false 不抛错', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    });
    const { result } = renderHook(() => useCopy());
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.copy('x');
    });
    expect(ok).toBe(false);
    expect(result.current.copied).toBe(false);
  });
});
