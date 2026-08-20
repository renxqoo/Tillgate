/**
 * 生产就绪性回归：这些断言描述生产必须满足的安全/入口契约。
 * 测试只读配置与源码，
 * 不依赖 PG/Redis，也不会修改生产数据。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const readRoot = (path: string) => readFileSync(`${ROOT}/${path}`, 'utf8');

const minimumEnv = {
  DATABASE_URL: 'postgres://user:password@localhost:5432/app',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: '0123456789abcdef0123456789abcdef',
};

describe('生产配置安全契约', () => {
  it('字符串 false 必须真的关闭公开注册与 Secure Cookie 开关', () => {
    const config = loadConfig({
      ...minimumEnv,
      REGISTER_ENABLED: 'false',
      SECURE_COOKIE: 'false',
    });

    // z.coerce.boolean() 会把任意非空字符串（包括 "false"）转为 true。
    // 结果是运营无法通过环境变量关闭自助注册。
    expect(config.REGISTER_ENABLED).toBe(false);
    expect(config.SECURE_COOKIE).toBe(false);
  });

  it('生产环境必须拒绝弱 JWT 密钥', () => {
    expect(() =>
      loadConfig({
        ...minimumEnv,
        NODE_ENV: 'production',
        JWT_SECRET: 'passwordpassword',
      }),
    ).toThrow();
  });

  it('生产环境必须启用 Secure Cookie，充值上下限不得倒置', () => {
    expect(() => loadConfig({
      ...minimumEnv,
      NODE_ENV: 'production',
      SECURE_COOKIE: 'false',
    })).toThrow('SECURE_COOKIE');
    expect(() => loadConfig({
      ...minimumEnv,
      TOPUP_MIN: '100.01',
      TOPUP_MAX: '100',
    })).toThrow('TOPUP_MIN');
  });
});

describe('生产入口拓扑契约', () => {
  it('OAuth 与支付 webhook 必须被 nginx 路由到 client-api', () => {
    const nginx = readRoot('docker/nginx/nginx.conf');

    expect(nginx).toMatch(/upstream\s+client_api_upstream\s*{/);
    expect(nginx).toMatch(/location[^{]*\/v1\/oauth\/[\s\S]*?proxy_pass\s+http:\/\/client_api_upstream/);
    expect(nginx).toMatch(
      /location[^{]*\/v1\/payments\/notify\/[\s\S]*?proxy_pass\s+http:\/\/client_api_upstream/,
    );
  });

  it('OAuth redirect_uri 不得被 compose 强制覆盖为 Docker 内网地址', () => {
    const compose = readRoot('docker/compose.yml');

    expect(compose).not.toMatch(/OAUTH_API_BASE:\s*http:\/\/client-api:8081/);
  });
});
