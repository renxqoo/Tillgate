import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { backfillTpm } from '../settle.js';
import type { UsageReceipt } from '../types.js';

// vitest 不自动加载 .env；本地 Redis 带密码，先注入再取连接串
{
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const f = resolve(dir, '.env');
    if (existsSync(f)) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
        if (m && m[1] && !(m[1] in process.env)) process.env[m[1]] = m[2];
      }
      break;
    }
    dir = dirname(dir);
  }
}

/**
 * 红测（复审 #2）：failover 场景的 TPM 回填口径。
 *
 * 预占 hash 会累积候选尝试的全部维度（主模型维 + 每个尝试渠道维 + fallback
 * 模型维）。回填脚本对 hash 里每个 reservedKey 都 INCRBY actual → 未承接
 * 请求的维度（已切走的主模型、试过即弃的渠道）实际用量被虚增，可能误触发
 * 它们的 429。正确口径（保持一致）：预占全释放；实际用量只记到
 * **收据归属**的维度（成功 mapping/channel + user×成功model + key/app）。
 *
 * 数据纪律：维度 ID 用 99xxxx 合成段（防与共享 dev Redis 的真实计数器键
 * 碰撞），清理时只按这些唯一 ID 精确删除（含跨分钟残留）。
 */
const USER = 990007;
const MAIN_MAP = 990001;
const FB_MAP = 990002;
const BAD_CHANNEL = 990009;
const OK_CHANNEL = 990010;
const KEY = 990003;
const DIMS = [
  `user:${USER}:model:${MAIN_MAP}`,
  `model:${MAIN_MAP}`,
  `channel:${BAD_CHANNEL}`,
  `user:${USER}:model:${FB_MAP}`,
  `model:${FB_MAP}`,
  `channel:${OK_CHANNEL}`,
  `key:${KEY}`,
];

const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
  retryStrategy: () => null,
  lazyConnect: true,
  maxRetriesPerRequest: null,
});
let connected = false;
beforeAll(async () => {
  try {
    await redis.connect();
    await redis.ping();
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => {
  // 清理全部合成维度的跨分钟残留（reserved/actual）
  if (connected) {
    for (const pattern of [
      `{tpm}:reserved:*user:${USER}:model:*`,
      `{tpm}:reserved:*model:${MAIN_MAP}`,
      `{tpm}:reserved:*model:${FB_MAP}`,
      `{tpm}:reserved:*channel:${BAD_CHANNEL}`,
      `{tpm}:reserved:*channel:${OK_CHANNEL}`,
      `{tpm}:reserved:*key:${KEY}`,
      `{tpm}:actual:*user:${USER}:model:*`,
      `{tpm}:actual:*model:${MAIN_MAP}`,
      `{tpm}:actual:*model:${FB_MAP}`,
      `{tpm}:actual:*channel:${BAD_CHANNEL}`,
      `{tpm}:actual:*channel:${OK_CHANNEL}`,
      `{tpm}:actual:*key:${KEY}`,
    ]) {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = next;
        if (keys.length > 0) await redis.del(...keys);
      } while (cursor !== '0');
    }
    await redis.del('{tpm}:request:tpm-bf-red-test', '{tpm}:projected:tpm-bf-red-test');
  }
  await redis.quit().catch(() => {});
});

function receipt(): UsageReceipt {
  return {
    requestId: 'tpm-bf-red-test',
    userId: USER,
    apiKeyId: KEY,
    appId: null,
    credentialType: 'api_key',
    externalModel: 'ext',
    realModel: 'fb-model',
    channelId: OK_CHANNEL, // fallback 承接渠道
    channelKey: 'p/c10',
    usage: { inputTokens: 400, cachedInputTokens: 0, outputTokens: 100, estimated: false },
    inputPrice: '0.000001',
    outputPrice: '0.000002',
    cacheInputPrice: '0',
    coefficient: '1',
    durationMs: 100,
    stream: false,
    streamAborted: false,
    mappingId: FB_MAP, // fallback mapping（主 mapping 已被切走）
    billingPolicyFingerprint: null,
  } as UsageReceipt;
}

describe('backfillTpm — 实际用量只记收据归属维度', () => {
  it('failover 后：未承接维度不加 actual；成功维度加；预占全释放', async (context) => {
    if (!connected) return context.skip('no Redis');
    const minute = Math.floor(Date.now() / 60_000);
    const reservedKeys = DIMS.slice(0, 6).map((dim) => `{tpm}:reserved:${minute}:${dim}`);
    const hash = '{tpm}:request:tpm-bf-red-test';
    await redis.del(hash, '{tpm}:projected:tpm-bf-red-test', ...reservedKeys);
    // 模拟网关预占轨迹：主模型维 + 坏渠道 + fallback 维 + 承接渠道
    const reserved: Array<[string, number]> = [
      [reservedKeys[0]!, 100], // user×主模型（已被切走）
      [reservedKeys[1]!, 100], // 主模型
      [reservedKeys[2]!, 100], // 试过但失败的渠道
      [reservedKeys[3]!, 100], // user×fallback（承接）
      [reservedKeys[4]!, 100], // fallback 模型
      [reservedKeys[5]!, 100], // 承接渠道
    ];
    for (const [key, amount] of reserved) {
      await redis.incrby(key, amount);
      await redis.hset(hash, key, amount);
    }

    await backfillTpm(redis, receipt());

    // ── 核心 bug 断言（当前实现把实际用量虚增到未承接维度 → 红灯）──
    expect(await redis.get(`{tpm}:actual:${minute}:user:${USER}:model:${MAIN_MAP}`)).toBeNull();
    expect(await redis.get(`{tpm}:actual:${minute}:model:${MAIN_MAP}`)).toBeNull();
    expect(await redis.get(`{tpm}:actual:${minute}:channel:${BAD_CHANNEL}`)).toBeNull();
    // ── 成功归属维度：actual = 500（400 input - 0 cache + 100 output）──
    expect(await redis.get(`{tpm}:actual:${minute}:user:${USER}:model:${FB_MAP}`)).toBe('500');
    expect(await redis.get(`{tpm}:actual:${minute}:model:${FB_MAP}`)).toBe('500');
    expect(await redis.get(`{tpm}:actual:${minute}:channel:${OK_CHANNEL}`)).toBe('500');
    expect(await redis.get(`{tpm}:actual:${minute}:key:${KEY}`)).toBe('500');
    // ── 预占全部释放为 0 ──
    for (const [key] of reserved) {
      expect(await redis.get(key)).toBe('0');
    }
    // 幂等标记 + hash 清理
    expect(await redis.exists(hash)).toBe(0);
    expect(await redis.exists('{tpm}:projected:tpm-bf-red-test')).toBe(1);
  });
});
