/**
 * 网关生产配置回归：环境变量解析必须 fail-closed。
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

const minimumEnv = {
  DATABASE_URL: 'postgres://user:password@localhost:5432/app',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: '0123456789abcdef0123456789abcdef',
  ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef',
};

describe('网关配置安全契约', () => {
  it('未配置固定预扣时保持 full 完整预扣', () => {
    const config = loadConfig(minimumEnv);
    expect(config.BILLING_RESERVATION_MODE).toBe('full');
    expect(config.BILLING_FIXED_RESERVATION_AMOUNT).toBeUndefined();
  });

  it('fixed 模式必须显式提供正金额字符串', () => {
    const config = loadConfig({
      ...minimumEnv,
      BILLING_RESERVATION_MODE: 'fixed',
      BILLING_FIXED_RESERVATION_AMOUNT: '0.01',
    });
    expect(config.BILLING_RESERVATION_MODE).toBe('fixed');
    expect(config.BILLING_FIXED_RESERVATION_AMOUNT).toBe('0.01');

    expect(() =>
      loadConfig({ ...minimumEnv, BILLING_RESERVATION_MODE: 'fixed' }),
    ).toThrow();
    expect(() =>
      loadConfig({
        ...minimumEnv,
        BILLING_RESERVATION_MODE: 'fixed',
        BILLING_FIXED_RESERVATION_AMOUNT: '0',
      }),
    ).toThrow();
    expect(() =>
      loadConfig({
        ...minimumEnv,
        BILLING_RESERVATION_MODE: 'fixed',
        BILLING_FIXED_RESERVATION_AMOUNT: '2',
        BILLING_RESERVATION_MAX: '1',
      }),
    ).toThrow();
  });

  it('字符串 false 不得开启本地/私网上游逃生门', () => {
    const config = loadConfig({
      ...minimumEnv,
      GATEWAY_AI_ALLOW_LOCAL_URL: 'false',
    });

    expect(config.GATEWAY_AI_ALLOW_LOCAL_URL).toBe(false);
  });

  it('生产环境必须拒绝可穷举的渠道加密密钥', () => {
    expect(() =>
      loadConfig({
        ...minimumEnv,
        NODE_ENV: 'production',
        ENCRYPTION_KEY: 'x',
      }),
    ).toThrow();
  });

  it('DEFAULT_USER_RPM/TPM 已删除：解析结果不含隐藏限额键（2026-08-21 黑盒子清除）', () => {
    const config = loadConfig(minimumEnv) as Record<string, unknown>;
    expect('DEFAULT_USER_RPM' in config).toBe(false);
    expect('DEFAULT_USER_TPM' in config).toBe(false);
  });

  it('残留 DEFAULT_USER_* 配置触发废弃告警（防静默失效——以为限着实则不限）', () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    try {
      loadConfig({ ...minimumEnv, DEFAULT_USER_RPM: '600', DEFAULT_USER_TPM: '100' });
    } finally {
      console.warn = original;
    }
    expect(warnings.some((w) => w.includes('DEFAULT_USER_RPM'))).toBe(true);
  });
});
