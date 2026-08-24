/**
 * config 契约测试：默认值 / 覆盖 / 生产 fail-fast 矩阵 / 组配置全-or-无（表驱动）。
 */
import { describe, expect, it } from 'vitest';
import { loadClientApiConfig } from '../src/config.js';

const BASE: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://localhost:5432/t',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: '0123456789abcdef0123456789abcdef',
  CLIENT_CODE_PEPPER: 'fedcba9876543210fedcba9876543210',
  ENCRYPTION_KEY: 'k1k2k3k4k5k6k7k8k9k0k1k2k3k4k5k6k7k8',
};

function load(env: Partial<NodeJS.ProcessEnv> = {}) {
  return loadClientApiConfig({ ...BASE, ...env });
}

// 模块级:组配置拒绝断言(提出 describe/it 回调,避免 expect 内箭头第 4 层嵌套)
function rejectLoad(env: Partial<NodeJS.ProcessEnv>, pattern: RegExp): void {
  expect(() => load(env)).toThrowError(pattern);
}

describe('client-api config', () => {
  it('缺必配项 fail-fast', () => {
    expect(() => loadClientApiConfig({})).toThrowError(/DATABASE_URL|Required/i);
  });

  it('默认值生效（端口/币种/闸门/时区/缓存）', () => {
    const c = load();
    expect(c.CLIENT_API_PORT).toBe(8081);
    expect(c.CLIENT_CURRENCY).toBe('CNY');
    expect(c.REGISTER_ENABLED).toBe(true);
    expect(c.REGISTER_IP_LIMIT_PER_HOUR).toBe(5);
    expect(c.REDEEM_PER_MINUTE_LIMIT).toBe(10);
    expect(c.CLIENT_TOPUP_ORDERS_PER_MINUTE).toBe(10);
    expect(c.LOGIN_FAILURE_THRESHOLD).toBe(5);
    expect(c.CLIENT_PASSWORD_MIN_LENGTH).toBe(10);
    expect(c.CLIENT_USAGE_TZ).toBe('Asia/Shanghai');
    expect(c.PRICING_CACHE_TTL_MS).toBe(30_000);
    expect(c.EPAY_PAY_TYPE).toBe('alipay');
    expect(c.KEY_PREFIX).toBe('sk_');
    expect(c.OTEL_TRACES_MODE).toBe('off');
  });

  it('覆盖生效', () => {
    const c = load({
      CLIENT_API_PORT: '9090',
      CLIENT_CURRENCY: 'USD',
      REGISTER_ENABLED: 'false',
      CLIENT_USAGE_TZ: 'UTC',
      EPAY_PAY_TYPE: 'wxpay',
      TRACE_RECEIVER_TOKEN: 'tok-1',
    });
    expect(c.CLIENT_API_PORT).toBe(9090);
    expect(c.CLIENT_CURRENCY).toBe('USD');
    expect(c.REGISTER_ENABLED).toBe(false);
    expect(c.CLIENT_USAGE_TZ).toBe('UTC');
    expect(c.EPAY_PAY_TYPE).toBe('wxpay');
    expect(c.TRACE_RECEIVER_TOKEN).toBe('tok-1');
  });

  it('弱密钥拒绝（secret 三闸）', () => {
    expect(() => load({ JWT_SECRET: 'short' })).toThrowError();
    expect(() => load({ CLIENT_CODE_PEPPER: 'abcd' })).toThrowError();
  });

  it('生产 fail-fast：SECURE_COOKIE=false 拒绝（缺省默认开）', () => {
    expect(() =>
      loadClientApiConfig({ ...BASE, NODE_ENV: 'production', SECURE_COOKIE: 'false' }),
    ).toThrowError(/SECURE_COOKIE/);
    expect(() => loadClientApiConfig({ ...BASE, NODE_ENV: 'production' })).not.toThrowError();
  });

  it('充值面额交叉校验：MIN > MAX 拒绝', () => {
    expect(() => load({ TOPUP_MIN: '500', TOPUP_MAX: '100' })).toThrowError(/TOPUP_MIN/);
  });

  describe('组配置全-or-无', () => {
    // CAPTCHA/SMTP/OAuth 凭据组校验已随 env 迁移迁入 integration_settings 写入侧
    // （control-plane update 用例——docs/integration-settings/DESIGN.md §5 D5）
    it.each([
      ['EPAY', { EPAY_PID: '1' }],
      ['STRIPE', { STRIPE_SECRET_KEY: 'sk' }],
    ])('%s 半配拒绝', (_name, patch) => {
      rejectLoad(patch, /as a group/);
    });

    it('EPAY 全配通过', () => {
      const c = load({
        EPAY_PID: '1',
        EPAY_KEY: 'k',
        EPAY_GATEWAY_URL: 'https://epay.example',
        EPAY_NOTIFY_URL: 'https://api.example/notify',
        EPAY_RETURN_URL: 'https://app.example/return',
      });
      expect(c.EPAY_PID).toBe('1');
    });

    it('sentinel 无主名拒绝', () => {
      rejectLoad({ REDIS_SENTINELS: 'h1:26379' }, /REDIS_SENTINEL_NAME/);
    });
  });

  it('端点覆盖非法 JSON fail-loud', () => {
    expect(() => load({ OAUTH_GITHUB_ENDPOINTS_JSON: '{oops' })).toThrowError(/valid JSON/);
  });
});
