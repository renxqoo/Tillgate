import { describe, expect, it } from 'vitest';
import { loadAdminApiConfig } from '../src/config';

/**
 * 配置契约（DESIGN §2.4）：缺省显式持有;秘密三道门;生产/显式 fail-fast。
 * 表驱动:BASE 全量合法 → 逐键扰动断言缺省或拒绝。
 */

const BASE: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/tillgate',
  ADMIN_JWT_SECRET: 'admin-jwt-secret-0123456789-abcdef',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'user-jwt-secret-0123456789-abcdef',
  ENCRYPTION_KEY: 'encryption-key-0123456789-abcdef',
  IDENTITY_CODE_PEPPER: 'pepper-0123-9abcd',
};

describe('loadAdminApiConfig', () => {
  it('缺省值（v1 等价值）', () => {
    const config = loadAdminApiConfig({ ...BASE });
    expect(config.port).toBe(8082);
    expect(config.sessionTtlSec).toBe(86_400);
    expect(config.keyPrefix).toBe('sk_');
    expect(config.channelImportMax).toBe(1000);
    expect(config.catalogFreeChannelRpm).toBe(20);
    expect(config.catalogFreeChannelBudget).toBe('1000000');
    expect(config.catalogCacheTtlMs).toBe(600_000);
    expect(config.voucherMaxBytes).toBe(2_097_152);
    expect(config.fx.sourceUrl).toBe('https://api.frankfurter.app/latest?from=USD&to=CNY');
    expect(config.fx.autoTtlMs).toBe(4 * 60 * 60 * 1000);
    expect(config.fx.fetchTimeoutMs).toBe(10_000);
    expect(config.corsOrigins).toEqual([]);
    expect(config.bodyLimitBytes).toBe(4_194_304);
    expect(config.shutdownGraceMs).toBe(10_000);
    expect(config.currency).toBe('CNY');
    expect(config.walletGuards.refTypes).toEqual(
      expect.arrayContaining(['billing', 'topup', 'admin', 'gift', 'referral']),
    );
    expect(config.dbPool.poolMax).toBe(10);
    expect(config.redisTopology).toEqual({ kind: 'direct' });
    // OTel 缺省:非生产 memory
    expect(config.otelMode).toBe('memory');
  });

  it('Redis Sentinel 拓扑需要主名并完整传递鉴权', () => {
    expect(() => loadAdminApiConfig({ ...BASE, REDIS_SENTINELS: 's1:26379' })).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ path: ['REDIS_SENTINEL_NAME'] }),
        ]),
      }),
    );
    expect(
      loadAdminApiConfig({
        ...BASE,
        REDIS_SENTINELS: 's1:26379,s2:26379',
        REDIS_SENTINEL_NAME: 'mymaster',
        REDIS_SENTINEL_PASSWORD: 'sentinel-secret',
      }).redisTopology,
    ).toEqual({
      kind: 'sentinel',
      sentinels: 's1:26379,s2:26379',
      sentinelName: 'mymaster',
      sentinelPassword: 'sentinel-secret',
    });
  });

  it('CORS 白名单逗号拆分与 trim', () => {
    const config = loadAdminApiConfig({ ...BASE, CORS_ORIGINS: 'https://a.test, https://b.test' });
    expect(config.corsOrigins).toEqual(['https://a.test', 'https://b.test']);
  });

  it('KEY_PREFIX 自定义值透传，非法大小写 fail-fast', () => {
    expect(loadAdminApiConfig({ ...BASE, KEY_PREFIX: 'tk-' }).keyPrefix).toBe('tk-');
    expect(() => loadAdminApiConfig({ ...BASE, KEY_PREFIX: 'Sk_' })).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ path: ['KEY_PREFIX'] })]),
      }),
    );
  });

  it('生产环境 OTel 缺省 off;显式配置优先', () => {
    expect(loadAdminApiConfig({ ...BASE, NODE_ENV: 'production' }).otelMode).toBe('off');
    expect(
      loadAdminApiConfig({
        ...BASE,
        OTEL_TRACES_MODE: 'otlp',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318',
      }).otelMode,
    ).toBe('otlp');
  });

  it('TRACE_RECEIVER_TOKEN → otelAuthToken(OTLP 推送鉴权,与接收端同键)', () => {
    expect(loadAdminApiConfig({ ...BASE }).otelAuthToken).toBeUndefined();
    expect(loadAdminApiConfig({ ...BASE, TRACE_RECEIVER_TOKEN: 'tok-1' }).otelAuthToken).toBe(
      'tok-1',
    );
  });

  it.each([
    ['DATABASE_URL 空', { DATABASE_URL: '' }, 'DATABASE_URL'],
    ['ADMIN_JWT_SECRET 过短', { ADMIN_JWT_SECRET: 'short' }, 'ADMIN_JWT_SECRET'],
    ['ADMIN_JWT_SECRET 字符多样性不足', { ADMIN_JWT_SECRET: 'a'.repeat(40) }, 'ADMIN_JWT_SECRET'],
    ['ENCRYPTION_KEY 过短', { ENCRYPTION_KEY: 'short' }, 'ENCRYPTION_KEY'],
    ['IDENTITY_CODE_PEPPER 过短', { IDENTITY_CODE_PEPPER: 'short' }, 'IDENTITY_CODE_PEPPER'],
    ['otlp 缺端点', { OTEL_TRACES_MODE: 'otlp' }, 'OTEL_EXPORTER_OTLP_ENDPOINT'],
    ['会话 TTL 越上界', { SESSION_TTL_SECONDS: '99999999' }, 'SESSION_TTL_SECONDS'],
    ['端口非整数', { ADMIN_API_PORT: 'abc' }, 'ADMIN_API_PORT'],
  ])('fail-fast:%s', (_name, patch, errorPath) => {
    expect(() => loadAdminApiConfig({ ...BASE, ...patch })).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ path: [errorPath] })]),
      }),
    );
  });
});
