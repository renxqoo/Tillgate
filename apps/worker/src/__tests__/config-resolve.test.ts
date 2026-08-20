/**
 * 内联配置归一化（resolveWorkerConfig）回归锁：
 * startWorker 直收对象（e2e/嵌入场景）绕过 loadConfig 的 zod 校验——
 * 缺字段静默 undefined（2026-08-21 事故：e2e 缺 REFERRAL_COMMISSION_RATE，
 * new Decimal(undefined) 每佣金 tick 崩，单轮 e2e 刷 362 次错误日志）。
 * 契约：入口归一化 = 缺字段填 schema 默认 / 非法值 fail-closed 抛错 / 多余字段剥离。
 */
import { describe, expect, it } from 'vitest';
import { loadConfig, resolveWorkerConfig } from '../config.js';

const BASE = {
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  REDIS_URL: 'redis://:root123@localhost:6379',
  CHANNEL_API_KEY_ENCRYPTION: 'unit-test-encryption-key-0123456789ab',
};

describe('resolveWorkerConfig（startWorker 内联配置归一化）', () => {
  it('REFERRAL_COMMISSION_RATE 已删除（营销参数 DB 化 2026-08-21）：schema 不含', () => {
    const config = resolveWorkerConfig(BASE) as Record<string, unknown>;
    expect('REFERRAL_COMMISSION_RATE' in config).toBe(false);
  });

  it('布尔字段接受 JS true/false 与 env 字符串两种形态（e2e 传布尔、env 传字符串）', () => {
    expect(resolveWorkerConfig(BASE).WORKER_SETTLE_WAKEUP).toBe(true); // 默认开
    expect(resolveWorkerConfig({ ...BASE, WORKER_SETTLE_WAKEUP: false }).WORKER_SETTLE_WAKEUP).toBe(false);
    expect(resolveWorkerConfig({ ...BASE, WORKER_SETTLE_WAKEUP: 'false' }).WORKER_SETTLE_WAKEUP).toBe(false);
  });

  it('数字字段缺省填默认、非法值 fail-closed 抛错（不再静默 undefined 落进定时器）', () => {
    expect(resolveWorkerConfig(BASE).WORKER_SETTLE_INTERVAL_MS).toBe(30_000);
    expect(() => resolveWorkerConfig({ ...BASE, WORKER_SETTLE_INTERVAL_MS: 'not-a-number' })).toThrow();
  });

  it('多余字段剥离（typos 不再悄悄溜进运行时）', () => {
    const config = resolveWorkerConfig({ ...BASE, WORKER_SETTLE_INTERVAL_MSX: 100 } as Record<string, unknown>);
    expect('WORKER_SETTLE_INTERVAL_MSX' in config).toBe(false);
    expect(config.WORKER_SETTLE_INTERVAL_MS).toBe(30_000);
  });

  it('必填基础设施缺失仍 fail-closed（不落默认值跑偏）', () => {
    expect(() => resolveWorkerConfig({ ...BASE, DATABASE_URL: undefined })).toThrow();
  });

  it('与 loadConfig 同一事实源：同一 env 两入口产出一致', () => {
    const env = { ...BASE, WORKER_OWNER_ID: 'parity-check', REFERRAL_COMMISSION_RATE: '0.1' } as unknown as NodeJS.ProcessEnv;
    expect(resolveWorkerConfig(env)).toEqual(loadConfig(env));
  });
});
