import { describe, expect, it } from 'vitest';
import { isDefectError } from '@tokenlens/errors';
import { parseSentinels } from '../src/redis/redis-client';

/** 断言装配期配置缺陷的身份与码（§11：检测点就地分类） */
function expectSentinelsDefect(spec: string, node?: string): void {
  try {
    parseSentinels(spec);
    expect.unreachable(`expected DefectError for ${spec}`);
  } catch (e) {
    expect(isDefectError(e), String(e)).toBe(true);
    expect((e as { code: string }).code).toBe('runtime.redis.sentinels_invalid');
    if (node !== undefined) {
      expect((e as { context?: { node?: string } }).context?.node).toBe(node);
    }
  }
}

describe('parseSentinels（装配期 fail-fast）', () => {
  it('合法多节点：host:port 逗号分隔', () => {
    expect(parseSentinels('h1:26379, h2:26379,h3:26380')).toEqual([
      { host: 'h1', port: 26379 },
      { host: 'h2', port: 26379 },
      { host: 'h3', port: 26380 },
    ]);
  });

  it('省略端口时缺省 26379（sentinel 默认端口）', () => {
    expect(parseSentinels('h1')).toEqual([{ host: 'h1', port: 26379 }]);
  });

  it('IPv6 形态 [::1]:26379 只切末段端口', () => {
    expect(parseSentinels('[::1]:26379')).toEqual([{ host: '[::1]', port: 26379 }]);
    expect(parseSentinels('::1:26379')).toEqual([{ host: '::1', port: 26379 }]);
  });

  it('非法端口抛 DefectError（非数字 / 0 / 负数；context 带非法节点）', () => {
    expectSentinelsDefect('h:abc', 'h:abc');
    expectSentinelsDefect('h:0', 'h:0');
    expectSentinelsDefect('h:-1', 'h:-1');
  });

  it('空规格抛 DefectError（空串 / 仅逗号）', () => {
    expectSentinelsDefect('');
    expectSentinelsDefect(' , ');
  });
});
