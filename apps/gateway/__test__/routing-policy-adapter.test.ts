import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@tillgate/db';
import { defaultRoutingPolicy, type RoutingPolicy } from '@tillgate/inference';
import type { RoutingPolicyRecord } from '@tillgate/control-plane';
import { createRedisStickyStore, createRoutingPolicySource } from '../src/adapters/routing-policy';

/**
 * 路由策略热源与 Redis sticky 适配器：
 *   - TTL 拾取（启动即取 + 周期刷新 + stop 停刷）；
 *   - 韧性分支：坏策略沿用上一份好值（onFault 记录）、无行回落编译期缺省；
 *   - sticky 编解码：数字串往返、未命中/坏值 → null、PX 透传。
 * store/redis 均为注入替身（生产形态 = postgres store + ioredis——e2e 覆盖）。
 */

/** 策略行替身（policy 为已落库 JSONB——findGlobal 返回形态） */
const rowOf = (policy: Record<string, unknown>): RoutingPolicyRecord => ({
  id: 1,
  scope: 'global',
  version: '1',
  policy,
  note: null,
  updatedBy: null,
  updatedAt: new Date('2026-08-30T00:00:00Z'),
});

const tweaked: RoutingPolicy = {
  ...defaultRoutingPolicy(),
  penalty: { ...defaultRoutingPolicy().penalty, rateLimitBaseMs: 5_000 },
};

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function sourceWith(
  findGlobal: (db: Db) => Promise<RoutingPolicyRecord | null>,
  ttlMs = 10,
  onFault?: (error: unknown, context: string) => void,
) {
  return createRoutingPolicySource({
    db: { stub: true } as never as Db,
    store: { findGlobal },
    ttlMs,
    ...(onFault != null ? { onFault } : {}),
  });
}

describe('createRoutingPolicySource', () => {
  it('启动即拾取 + 周期刷新 + stop 停刷（TTL 驱动）', async () => {
    let row: RoutingPolicyRecord | null = rowOf(tweaked as unknown as Record<string, unknown>);
    const source = sourceWith(async () => row);
    // 拾取前 = 编译期缺省（内存 latest 零 IO 读）
    expect(source.reader.latest()).toEqual(defaultRoutingPolicy());
    const stop = source.start();
    await vi.waitFor(() => expect(source.reader.latest()).toEqual(tweaked));

    // 周期刷新：store 变更后 ≤ttlMs 反映新值
    row = rowOf({
      ...tweaked,
      wait: { enabled: false, maxWaitMs: 3_000 },
    } as unknown as Record<string, unknown>);
    await vi.waitFor(() => expect(source.reader.latest().wait.enabled).toBe(false));

    // stop 后不再拾取（跨过多个 TTL 周期值不变）
    stop();
    row = rowOf({
      ...tweaked,
      retry: { sameChannelMaxRetries: 6 },
    } as unknown as Record<string, unknown>);
    await sleep(40);
    expect(source.reader.latest().retry.sameChannelMaxRetries).toBe(3);
  });

  it('坏策略：解析失败沿用上一份好值，onFault 记录（路由不因配置损坏挂）', async () => {
    const faults: Array<[unknown, string]> = [];
    let row: RoutingPolicyRecord | null = rowOf(tweaked as unknown as Record<string, unknown>);
    const source = sourceWith(
      async () => row,
      10,
      (error, context) => faults.push([error, context]),
    );
    const stop = source.start();
    await vi.waitFor(() => expect(source.reader.latest()).toEqual(tweaked));

    row = { ...rowOf({ retry: { sameChannelMaxRetries: 'not-a-number' } }) };
    await sleep(40);
    expect(source.reader.latest()).toEqual(tweaked); // 沿用旧值
    expect(faults.length).toBeGreaterThanOrEqual(1);
    expect(faults[0]?.[1]).toBe('policy refresh');
    stop();
  });

  it('无行：保持现值（首启 = 编译期缺省，不回落空策略）', async () => {
    const source = sourceWith(async () => null);
    const stop = source.start();
    await sleep(30);
    expect(source.reader.latest()).toEqual(defaultRoutingPolicy());
    stop();
  });

  it('store 故障（findGlobal 抛错）：fail-open 保持现值，onFault 记录', async () => {
    const faults: string[] = [];
    let broken = false;
    const source = sourceWith(
      async () => {
        if (broken) throw new Error('db down');
        return rowOf(tweaked as unknown as Record<string, unknown>);
      },
      10,
      (_error, context) => faults.push(context),
    );
    const stop = source.start();
    await vi.waitFor(() => expect(source.reader.latest()).toEqual(tweaked));
    broken = true;
    await sleep(40);
    expect(source.reader.latest()).toEqual(tweaked);
    expect(faults).toContain('policy refresh');
    stop();
  });
});

/** ioredis 最小替身（get/set；PX 语义以 Map + 过期时间近似——断言透传参数） */
function fakeRedis() {
  const values = new Map<string, string>();
  const px = new Map<string, number>();
  return {
    values,
    px,
    async get(key: string): Promise<string | null> {
      return values.get(key) ?? null;
    },
    // ioredis set 位置签名（key, value, mode, ttl）——测试替身镜像调用面
    // eslint-disable-next-line max-params -- 镜像 ioredis set(key,value,mode,ttl) 位置签名
    async set(key: string, value: string, mode?: string, ttlMs?: number): Promise<string> {
      values.set(key, value);
      if (mode === 'PX' && ttlMs != null) px.set(key, ttlMs);
      return 'OK';
    },
  };
}

describe('createRedisStickyStore', () => {
  it('set/get 往返：sticky: 前缀 + 数字串 + PX 透传', async () => {
    const redis = fakeRedis();
    const store = createRedisStickyStore(redis as never);
    await store.set('abc123', 42, 300_000);
    expect(redis.values.get('inference:sticky:abc123')).toBe('42');
    expect(redis.px.get('inference:sticky:abc123')).toBe(300_000);
    expect(await store.get('abc123')).toBe(42);
  });

  it('未命中/坏值/非正整数 → null（fail-open：无粘滞不反噬请求）', async () => {
    const redis = fakeRedis();
    const store = createRedisStickyStore(redis as never);
    expect(await store.get('missing')).toBeNull();
    redis.values.set('inference:sticky:bad', 'not-a-number');
    expect(await store.get('bad')).toBeNull();
    redis.values.set('inference:sticky:zero', '0');
    expect(await store.get('zero')).toBeNull();
    redis.values.set('inference:sticky:frac', '3.5');
    expect(await store.get('frac')).toBeNull();
  });
});
