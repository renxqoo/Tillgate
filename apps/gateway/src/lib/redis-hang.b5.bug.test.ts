import { describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';

/**
 * B5 回归测试 —— Redis 宕机时业务连接必须 fail-open（reject），而非无限挂起。
 *
 * 背景：原生产配置（index.ts:144）用单条 Redis 连接 + maxRetriesPerRequest: null，
 * ioredis 默认 enableOfflineQueue: true → 宕机时业务命令进 offline queue 永不 reject，
 * billing/route-cache/key-auth 的 try/catch fail-open 分支不可达 → /v1/* 全部 hang。
 *
 * 修复（index.ts）：拆两条连接——BullMQ 专用保留 null；业务连接用：
 *   enableOfflineQueue: false + maxRetriesPerRequest: 1 + commandTimeout。
 *
 * 本测试验证两种配置的行为差异：
 *   - 旧配置（maxRetriesPerRequest:null + 默认 offlineQueue）→ 挂起（复现原 bug）
 *   - 新配置（业务连接选项）→ 有限时间内 reject（fail-open 可达）
 */

describe('B5 — Redis 连接配置：业务连接在宕机时 fail-open（reject），不再挂起', () => {
  it('旧配置（maxRetriesPerRequest:null）→ 命令挂起（复现原 bug）', { timeout: 15_000 }, async () => {
    const redis = new Redis('redis://127.0.0.1:1', {
      lazyConnect: true,
      maxRetriesPerRequest: null, // 原生产配置
      connectTimeout: 500,
      retryStrategy: () => 200,
    });
    await redis.connect().catch(() => {});

    let settled = false;
    redis.get('any-key').then(() => { settled = true; }, () => { settled = true; });

    await new Promise((r) => setTimeout(r, 3_000));
    redis.disconnect();
    // 旧配置：3s 内命令既没 resolve 也没 reject（挂在 offline queue）→ 证明原 bug
    expect(settled).toBe(false);
  });

  it('新配置（业务连接：enableOfflineQueue:false + 有限重试 + commandTimeout）→ 有限时间内 reject', { timeout: 15_000 }, async () => {
    // 与 index.ts 修复后的业务连接选项一致
    const redis = new Redis('redis://127.0.0.1:1', {
      lazyConnect: true,
      enableOfflineQueue: false, // 宕机时立即 reject
      maxRetriesPerRequest: 1,
      commandTimeout: 500,
      connectTimeout: 500,
      retryStrategy: (times) => (times > 3 ? null : 100),
    });
    await redis.connect().catch(() => {});

    let rejected = false;
    let resolved = false;
    try {
      await redis.get('any-key');
      resolved = true;
    } catch {
      rejected = true; // 期望：fail-open（reject）
    }
    redis.disconnect();
    // 修复后：业务命令在有限时间内 reject → fail-open catch 可达
    expect(rejected).toBe(true);
    expect(resolved).toBe(false);
  });
});
