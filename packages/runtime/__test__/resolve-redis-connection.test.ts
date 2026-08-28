import { describe, expect, it } from 'vitest';
import { resolveRedisConnection } from '../src/redis/resolve-redis-connection';

describe('resolveRedisConnection', () => {
  it('直连形态保留完整 URL，不伪造 Sentinel 参数', () => {
    expect(resolveRedisConnection('redis://:secret@redis:6379/2', {})).toEqual({
      kind: 'direct',
      url: 'redis://:secret@redis:6379/2',
    });
  });

  it('Sentinel 形态从拓扑与 URL 各取单一真相', () => {
    expect(
      resolveRedisConnection('redis://:data-pass@redis:6379/3', {
        sentinels: 's1:26379,s2:26380',
        sentinelName: 'money-master',
        sentinelPassword: 'sentinel-pass',
      }),
    ).toEqual({
      kind: 'sentinel',
      options: {
        sentinels: [
          { host: 's1', port: 26379 },
          { host: 's2', port: 26380 },
        ],
        name: 'money-master',
        sentinelPassword: 'sentinel-pass',
        password: 'data-pass',
        db: 3,
      },
    });
  });

  it('Sentinel 形态的非法 db 在装配期 fail-closed', () => {
    expect(() =>
      resolveRedisConnection('redis://redis:6379/not-a-db', {
        sentinels: 's1:26379',
        sentinelName: 'mymaster',
      }),
    ).toThrow(/invalid Redis database number/);
  });
});
