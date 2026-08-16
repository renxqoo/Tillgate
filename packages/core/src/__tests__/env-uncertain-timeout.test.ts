import { describe, expect, it } from 'vitest';

/**
 * R11-B uncertain 时效放行 env 契约：
 *   - 双参数【无默认值】：都不配 → 通道关闭（字段 undefined）
 *   - 只配其一 → 拒绝启动（缺一即拒，不允许半配置的隐式语义）
 *   - 金额为 0 / 非法 → 拒绝
 */

const BASE = {
  DATABASE_URL: 'postgres://x',
  REDIS_URL: 'redis://x',
  JWT_SECRET: 'a-strong-jwt-secret-32-chars-minimum!!',
  ENCRYPTION_KEY: 'a-strong-encryption-key-32-chars-min!!',
};

describe('core env — WORKER_UNCERTAIN_TIMEOUT_*', () => {
  it('都不配 → undefined（时效通道关闭，无默认值）', async () => {
    const { loadWorkerEnv } = await import('../../src/index.js');
    const parsed = loadWorkerEnv(BASE);
    expect(parsed.WORKER_UNCERTAIN_TIMEOUT_HOURS).toBeUndefined();
    expect(parsed.WORKER_UNCERTAIN_TIMEOUT_MAX_AMOUNT).toBeUndefined();
  });

  it('只配 HOURS 或只配 MAX_AMOUNT → 启动即拒', async () => {
    const { loadWorkerEnv } = await import('../../src/index.js');
    expect(() =>
      loadWorkerEnv({ ...BASE, WORKER_UNCERTAIN_TIMEOUT_HOURS: '24' }),
    ).toThrow(/必须同时配置/);
    expect(() =>
      loadWorkerEnv({ ...BASE, WORKER_UNCERTAIN_TIMEOUT_MAX_AMOUNT: '5' }),
    ).toThrow(/必须同时配置/);
  });

  it('金额 0 → 拒绝；双参数齐备 → 正确解析', async () => {
    const { loadWorkerEnv } = await import('../../src/index.js');
    expect(() =>
      loadWorkerEnv({
        ...BASE,
        WORKER_UNCERTAIN_TIMEOUT_HOURS: '24',
        WORKER_UNCERTAIN_TIMEOUT_MAX_AMOUNT: '0',
      }),
    ).toThrow(/必须为正/);
    const parsed = loadWorkerEnv({
      ...BASE,
      WORKER_UNCERTAIN_TIMEOUT_HOURS: '48',
      WORKER_UNCERTAIN_TIMEOUT_MAX_AMOUNT: '5.5',
    });
    expect(parsed.WORKER_UNCERTAIN_TIMEOUT_HOURS).toBe(48);
    expect(parsed.WORKER_UNCERTAIN_TIMEOUT_MAX_AMOUNT).toBe('5.5');
  });
});
