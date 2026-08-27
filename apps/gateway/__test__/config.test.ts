/**
 * 配置契约：
 * 缺省值表 / 必填 fail-closed / fixed-full 交叉校验 / 生产密钥门槛 / SSRF 逃生门 /
 * GLOBAL_RPM 生产钳制 / 废弃键告警。
 */
import { describe, expect, it, vi } from 'vitest';
import { loadGatewayConfig } from '../src/config';

const secret = (seed: string, len: number) =>
  Array.from({ length: len }, (_, i) => seed[i % seed.length]).join('');
const BASE = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  CHANNEL_API_KEY_ENCRYPTION: secret('aB3d', 32),
  JWT_SECRET: secret('eF5g', 32),
};

describe('缺省值与推导', () => {
  it('缺省表（v1 等价值逐项）', () => {
    const c = loadGatewayConfig({ ...BASE });
    expect(c.otel.mode).toBe('off');
    expect(c.otel.authToken).toBeUndefined();
    expect(c.redisTopology).toEqual({ kind: 'direct' });
    expect(c.port).toBe(8_080);
    expect(c.currency).toBe('CNY');
    expect(c.reservationLimit).toBe('1000');
    expect(c.reservationPolicy).toEqual({ mode: 'full' });
    expect(c.authorizationTtlMs).toBe(300_000);
    expect(c.generationTaskTtlMs).toBe(3_600_000);
    expect(c.generationLeaseGraceMs).toBe(30_000);
    expect(c.globalRpm).toBe(2_000);
    expect(c.preauthIpRpm).toBe(1_200);
    expect(c.upstreamDeadlineMs).toBe(120_000);
    expect(c.upstreamConnectTimeoutMs).toBe(10_000);
    expect(c.bodyLimitBytes).toBe(10 * 1024 * 1024);
    expect(c.uploadLimits.maxFileBytes).toBe(10 * 1024 * 1024); // 与 bodyLimit 取 min
    expect(c.keyPrefix).toBe('sk_');
    expect(c.oauth.issuer).toBe('ai-gateway');
    expect(c.oauth.audience).toBe('ai-gateway-api');
    expect(c.oauth.tokenTtlSeconds).toBe(3_600);
    expect(c.output).toEqual({ defaultMaxOutputTokens: 4_096, exposureCap: 32_768 });
    expect(c.settleSignal).toEqual({ attempts: 5, baseDelayMs: 500 });
    expect(c.drainFinalizeMs).toBe(5_000);
    expect(c.corsOrigins).toEqual([]);
  });

  it('Redis Sentinel 拓扑需要主名并完整传递鉴权', () => {
    expect(() => loadGatewayConfig({ ...BASE, REDIS_SENTINELS: 's1:26379' })).toThrow(
      /REDIS_SENTINEL_NAME/,
    );
    expect(
      loadGatewayConfig({
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

  it('显式覆盖：字节量/origins/policy fixed', () => {
    const c = loadGatewayConfig({
      ...BASE,
      GATEWAY_BODY_LIMIT_BYTES: '16MB',
      GATEWAY_UPLOAD_MAX_FILE_BYTES: '32MB',
      GATEWAY_CORS_ORIGINS: 'https://a.example, https://b.example',
      BILLING_RESERVATION_MODE: 'fixed',
      BILLING_FIXED_RESERVATION_AMOUNT: '0.5',
      GLOBAL_RPM: '0',
      PREAUTH_IP_RPM: '0',
    });
    expect(c.bodyLimitBytes).toBe(16 * 1024 * 1024);
    expect(c.uploadLimits.maxFileBytes).toBe(16 * 1024 * 1024);
    expect(c.corsOrigins).toEqual(['https://a.example', 'https://b.example']);
    expect(c.reservationPolicy).toEqual({ mode: 'fixed', amount: '0.5' });
    expect(c.globalRpm).toBeNull(); // 0 = 不限
    expect(c.preauthIpRpm).toBeNull(); // 0 = 不设预认证闸
  });

  it('OTLP 覆盖：mode/endpoint/TRACE_RECEIVER_TOKEN → otel.authToken', () => {
    const c = loadGatewayConfig({
      ...BASE,
      OTEL_TRACES_MODE: 'otlp',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://trace-receiver:8088',
      TRACE_RECEIVER_TOKEN: 'tok-1',
    });
    expect(c.otel).toMatchObject({
      mode: 'otlp',
      endpoint: 'http://trace-receiver:8088',
      authToken: 'tok-1',
    });
  });

  it('ENCRYPTION_KEY 回落：CHANNEL_API_KEY_ENCRYPTION 缺省时旧键兜底', () => {
    const { CHANNEL_API_KEY_ENCRYPTION: _drop, ...rest } = BASE;
    const c = loadGatewayConfig({ ...rest, ENCRYPTION_KEY: secret('hI7j', 32) });
    expect(c.channelApiKeyEncryption).toBe(secret('hI7j', 32));
  });
});

describe('fail-closed', () => {
  it('必填缺失拒绝启动（URL/密钥）', () => {
    expect(() => loadGatewayConfig({ ...BASE, DATABASE_URL: undefined })).toThrow();
    expect(() => loadGatewayConfig({ ...BASE, REDIS_URL: 'notaurl' })).toThrow();
    expect(() => loadGatewayConfig({ ...BASE, JWT_SECRET: 'short' })).toThrow();
    expect(() =>
      loadGatewayConfig({ ...BASE, CHANNEL_API_KEY_ENCRYPTION: secret('xY9z', 16) }),
    ).toThrow();
  });

  it('fixed 模式缺金额拒绝；金额串非法拒绝', () => {
    expect(() => loadGatewayConfig({ ...BASE, BILLING_RESERVATION_MODE: 'fixed' })).toThrow(
      /BILLING_FIXED_RESERVATION_AMOUNT/,
    );
    expect(() =>
      loadGatewayConfig({
        ...BASE,
        BILLING_RESERVATION_MODE: 'fixed',
        BILLING_FIXED_RESERVATION_AMOUNT: '-1',
      }),
    ).toThrow();
  });

  it('生产弱 JWT 密钥拒绝（32 门槛）；开发 16 即可', () => {
    expect(() =>
      loadGatewayConfig({ ...BASE, NODE_ENV: 'production', JWT_SECRET: secret('xY9z', 16) }),
    ).toThrow();
    expect(() => loadGatewayConfig({ ...BASE, JWT_SECRET: secret('xY9z', 16) })).not.toThrow();
  });

  it('生产启动不再要求上游白名单 env（ADR-0010：出口信任锚在运营面）', () => {
    expect(() =>
      loadGatewayConfig({ ...BASE, NODE_ENV: 'production', JWT_SECRET: secret('xY9z', 32) }),
    ).not.toThrow();
  });

  it('SSRF 逃生门：字符串 "false" 不开门；生产误配也恒关', () => {
    expect(
      loadGatewayConfig({ ...BASE, GATEWAY_AI_ALLOW_LOCAL_URL: 'false' }).aiAllowLocalUrl,
    ).toBe(false);
    expect(loadGatewayConfig({ ...BASE, GATEWAY_AI_ALLOW_LOCAL_URL: 'true' }).aiAllowLocalUrl).toBe(
      true,
    );
    expect(
      loadGatewayConfig({
        ...BASE,
        NODE_ENV: 'production',
        GATEWAY_AI_ALLOW_LOCAL_URL: 'true',
      }).aiAllowLocalUrl,
    ).toBe(true); // config 层如实透传；装配层与 NODE_ENV 双门收口（assembly 测试覆盖）
  });

  it('生产 GLOBAL_RPM 超配钳到 5000 并告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = loadGatewayConfig({
      ...BASE,
      NODE_ENV: 'production',
      GLOBAL_RPM: '99999',
    });
    expect(c.globalRpm).toBe(5_000);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('废弃键告警且不进 schema（用户级限流无兜底默认）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadGatewayConfig({ ...BASE, DEFAULT_USER_RPM: '100', GENERATION_MAX_ACTIVE_PER_USER: '5' });
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('DEFAULT_USER_RPM'))).toHaveLength(
      1,
    );
    warn.mockRestore();
  });
});
