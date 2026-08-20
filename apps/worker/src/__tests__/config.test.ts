import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

const base = {
  DATABASE_URL: 'postgres://user:password@localhost:5432/app',
  REDIS_URL: 'redis://localhost:6379',
  ENCRYPTION_KEY: 'worker-config-encryption-key-32char',
};

describe('Worker 配置 fail-closed', () => {
  it('字符串 false 确实关闭通知和唤醒循环', () => {
    const config = loadConfig({
      ...base,
      WORKER_NOTIFY_ENABLED: 'false',
      WORKER_SETTLE_WAKEUP: 'false',
    });
    expect(config.WORKER_NOTIFY_ENABLED).toBe(false);
    expect(config.WORKER_SETTLE_WAKEUP).toBe(false);
  });

  it('拒绝含糊布尔值、弱密钥与非十进制佣金比例', () => {
    expect(() => loadConfig({ ...base, WORKER_NOTIFY_ENABLED: '0' })).toThrow();
    expect(() => loadConfig({ ...base, ENCRYPTION_KEY: 'short' })).toThrow();
    expect(() => loadConfig({ ...base, REFERRAL_COMMISSION_RATE: '1e-1' })).toThrow();
  });
});
