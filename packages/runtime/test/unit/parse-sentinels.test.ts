import { describe, expect, it } from 'vitest';
import { parseSentinels } from '../../src/redis/redis-client';

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

  it('非法端口抛错（非数字 / 0 / 负数）', () => {
    expect(() => parseSentinels('h:abc')).toThrow('非法节点');
    expect(() => parseSentinels('h:0')).toThrow('非法节点');
    expect(() => parseSentinels('h:-1')).toThrow('非法节点');
  });

  it('空规格抛错（空串 / 仅逗号）', () => {
    expect(() => parseSentinels('')).toThrow('REDIS_SENTINELS 为空');
    expect(() => parseSentinels(' , ')).toThrow('REDIS_SENTINELS 为空');
  });
});
