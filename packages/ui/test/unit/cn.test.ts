import { describe, expect, it } from 'vitest';

import { cn } from '../../src/cn';

describe('cn', () => {
  it('拼接多个类名', () => {
    expect(cn('a', 'b')).toBe('a b');
  });

  it('过滤假值', () => {
    const disabled = false;
    expect(cn('a', disabled && 'b', undefined, null, 'c')).toBe('a c');
  });

  it('tailwind 冲突后者胜出', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4');
    expect(cn('text-sm', 'text-lg', 'font-medium')).toBe('text-lg font-medium');
  });

  it('空输入返回空串', () => {
    expect(cn()).toBe('');
  });
});
