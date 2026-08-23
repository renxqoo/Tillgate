/**
 * 真实 PG + Redis 全链冒烟（test:real 通道；默认门禁按文件名排除）。
 * 覆盖默认门禁不触的装配根与 adapters SQL：启动装配 fail-closed、healthz 双检、
 * 公开端点目录查询、无 SMTP 注册 503（两级登录 fail-closed）、未知凭据 401。
 * 完整用户旅程（注册→登录→Key→支付回调→对账）归根 e2e/（MIGRATION §1 暂缓项）。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ping, closeDb } from '@tokenlens/db';
import { loadClientApiConfig } from '../src/config.js';
import { assembleClientApi } from '../src/assembly.js';
import { createClientApiApp } from '../src/app.js';

const env: NodeJS.ProcessEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
  JWT_SECRET: process.env.JWT_SECRET ?? 'real-test-jwt-secret-0123456789ab',
  CLIENT_CODE_PEPPER: process.env.CLIENT_CODE_PEPPER ?? 'real-test-pepper-0123456789abcd',
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? 'real-test-enc-key-0123456789abcd',
};

const context = describe.skipIf(
  await (async () => {
    try {
      const { createRedisClient, assertRedisReachable } = await import('@tokenlens/runtime');
      const redis = createRedisClient(env.REDIS_URL as string, {
        serviceName: 'client-api-real-probe',
        logThrottleMs: 1_000,
      });
      await assertRedisReachable(redis, 'client-api-real-probe', env.REDIS_URL as string, 3_000);
      await redis.quit().catch(() => undefined);
      return false;
    } catch {
      return true;
    }
  })(),
);

let assembly: Awaited<ReturnType<typeof assembleClientApi>> | null = null;

afterAll(async () => {
  if (assembly != null) {
    await assembly.redis.quit().catch(() => undefined);
    await assembly.otel.shutdown().catch(() => undefined);
    await closeDb(assembly.db);
  }
});

context('client-api 真实链路', () => {
  it('装配 + healthz + 公开端点 + fail-closed 语义', async () => {
    const config = loadClientApiConfig(env);
    assembly = await assembleClientApi(config);
    const app = createClientApiApp(assembly.deps);

    // DB 真连通（装配已建池——healthz 直接应答）
    const health = await app.request('/healthz');
    expect(health.status).toBe(200);

    // 公开目录（表可能为空——信封形状即可）
    const plans = await app.request('/v1/plans');
    expect(plans.status).toBe(200);
    expect(Array.isArray(((await plans.json()) as { rows: unknown[] }).rows)).toBe(true);

    const pricing = await app.request('/v1/pricing');
    expect(pricing.status).toBe(200);

    // 无 SMTP：注册恒两步 → 邮件通道 fail-closed 503（绝不静默单步成功）
    const register = await app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `smoke-${Date.now()}@example.com`, password: 'password123' }),
    });
    expect(register.status).toBe(503);

    // 未知凭据 401（防枚举统一口径）
    const login = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'password123' }),
    });
    expect(login.status).toBe(401);
    expect(((await login.json()) as { error: { code: string } }).error.code).toBe(
      'identity.invalid_credentials',
    );

    // adapters SQL 冒烟：usage 查询在空数据用户上返回空集（需会话——直接调读面）
    const usage = await assembly.deps.usage.list(9_999_999, { page: 1, limit: 20 });
    expect(usage.total).toBe(0);
    const summary = await assembly.deps.usage.summary(9_999_999, {});
    expect(summary.list).toHaveLength(0);
    const rate = await assembly.deps.usage.rate(9_999_999);
    expect(rate.rpm).toBe(0);

    await ping(assembly.db);
  });
});
