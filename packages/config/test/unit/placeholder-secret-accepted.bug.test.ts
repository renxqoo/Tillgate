import { describe, expect, it } from 'vitest';

/**
 * BUG C-1 — .env.example 占位值 change-me-32-chars-minimum-secret 被 config 接受
 *
 * 验证：直接对 secretSchema 调用 .parse()，看历史占位值是否被拒。
 * 修复后期望：拒绝（占位密钥不可用于生产）。
 * 当前（BUG）：接受（passes validation）。
 *
 * 危险场景：
 *   cp .env.example .env && pnpm dev
 *   → JWT_SECRET = change-me-32-chars-minimum-secret
 *   → 任何攻击者都知道这个密钥 → 可伪造任意 userId 的 JWT → 绕过鉴权 + 余额
 *   → 同时是 ENCRYPTION_KEY 的占位 → 所有渠道上游 API Key 都能被解密
 */

// 加载 .env 之前清理，让 secretSchema 只看我们传入的值
describe('BUG C-1 — config.secretSchema 应拒绝 .env.example 占位密钥', () => {
  it('change-me-32-chars-minimum-secret 必须被拒绝（当前被接受）', async () => {
    // 隔离环境：确保 process.env 没有真生产密钥覆盖
    const origJwt = process.env.JWT_SECRET;
    const origEnc = process.env.ENCRYPTION_KEY;
    delete process.env.JWT_SECRET;
    delete process.env.ENCRYPTION_KEY;

    try {
      const { loadAdminApiEnv, loadGatewayEnv } = await import('../../src/index.js');
      // admin-api 和 gateway 都调用 secretSchema，应该拒绝占位值
      expect(() => loadAdminApiEnv({
        DATABASE_URL: 'postgres://x',
        REDIS_URL: 'redis://x',
        JWT_SECRET: 'change-me-32-chars-minimum-secret',
        ENCRYPTION_KEY: 'change-me-32-chars-minimum-secret',
      })).toThrow(/占位|弱密钥/);

      expect(() => loadGatewayEnv({
        DATABASE_URL: 'postgres://x',
        REDIS_URL: 'redis://x',
        JWT_SECRET: 'change-me-32-chars-minimum-secret',
        ENCRYPTION_KEY: 'change-me-32-chars-minimum-secret',
      })).toThrow(/占位|弱密钥/);
    } finally {
      if (origJwt) process.env.JWT_SECRET = origJwt;
      if (origEnc) process.env.ENCRYPTION_KEY = origEnc;
    }
  });

  it('对照组：合法强密钥应通过', async () => {
    const origJwt = process.env.JWT_SECRET;
    const origEnc = process.env.ENCRYPTION_KEY;
    delete process.env.JWT_SECRET;
    delete process.env.ENCRYPTION_KEY;

    try {
      const { loadAdminApiEnv } = await import('../../src/index.js');
      const env = loadAdminApiEnv({
        DATABASE_URL: 'postgres://x',
        REDIS_URL: 'redis://x',
        JWT_SECRET: 'a-strong-jwt-secret-for-testing-only-7f3a',
        ENCRYPTION_KEY: 'a-strong-encryption-key-32-chars-min!!',
      });
      expect(env.JWT_SECRET).toBe('a-strong-jwt-secret-for-testing-only-7f3a');
    } finally {
      if (origJwt) process.env.JWT_SECRET = origJwt;
      if (origEnc) process.env.ENCRYPTION_KEY = origEnc;
    }
  });
});