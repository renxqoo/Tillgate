import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { loadTraceReceiverConfig } from '../src/config';

/**
 * 配置层规格:缺省值表、模式推导、生产 fail-fast 两道闸、令牌三道门。
 * (表驱动优先——新增 env 键自动获得缺省断言位)
 */

const BASE = { DATABASE_URL: 'postgres://u:p@host:5432/db' } as const;
// 满足 secretSchema 三道门:≥16 字符、非已知弱值、≥4 种不同字符
const STRONG_TOKEN = 'tr-receiver-token-9f3k2m';

function parse(env: Record<string, string | undefined>) {
  return loadTraceReceiverConfig(env as NodeJS.ProcessEnv);
}

describe('缺省值(开发内网最小配置)', () => {
  it('仅 DATABASE_URL(+显式开放逃生门)即可装配,部署缺省逐项落位', () => {
    const config = parse({ ...BASE, TRACE_RECEIVER_OPEN: 'true' });
    expect(config).toMatchObject({
      logLevel: 'info',
      databaseUrl: 'postgres://u:p@host:5432/db',
      port: 8793,
      receiverToken: undefined,
      batchMax: 500,
      flushIntervalMs: 2_000,
      queueMax: 10_000,
      otelMode: 'memory',
      otelEndpoint: undefined,
      dbPool: {
        poolMax: 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
      },
    });
  });

  it('显式覆盖优先于缺省', () => {
    const config = parse({
      ...BASE,
      TRACE_RECEIVER_OPEN: 'true',
      LOG_LEVEL: 'debug',
      TRACE_RECEIVER_PORT: '9000',
      TRACE_BATCH_MAX: '50',
      TRACE_FLUSH_INTERVAL_MS: '500',
      TRACE_QUEUE_MAX: '2000',
    });
    expect(config).toMatchObject({
      logLevel: 'debug',
      port: 9000,
      batchMax: 50,
      flushIntervalMs: 500,
      queueMax: 2000,
    });
  });
});

describe('otel 模式推导', () => {
  it('NODE_ENV=production 缺省 off;显式配置优先于推导', () => {
    expect(
      parse({ ...BASE, NODE_ENV: 'production', TRACE_RECEIVER_TOKEN: STRONG_TOKEN }).otelMode,
    ).toBe('off');
    expect(
      parse({
        ...BASE,
        NODE_ENV: 'production',
        TRACE_RECEIVER_TOKEN: STRONG_TOKEN,
        OTEL_TRACES_MODE: 'memory',
      }).otelMode,
    ).toBe('memory');
    expect(
      parse({ ...BASE, TRACE_RECEIVER_OPEN: 'true', OTEL_TRACES_MODE: 'console' }).otelMode,
    ).toBe('console');
  });

  it('mode=otlp 缺端点不在 config 报错——fail-fast 单一所有者是 initOtel(装配层测试锁定)', () => {
    // config 只透传;assembleReceiver 才触发 observabilityErrors.otel_endpoint_missing
    const config = parse({ ...BASE, TRACE_RECEIVER_OPEN: 'true', OTEL_TRACES_MODE: 'otlp' });
    expect(config.otelMode).toBe('otlp');
    expect(config.otelEndpoint).toBeUndefined();
  });
});

describe('fail-fast 闸(抛 zod 错误)', () => {
  it.each([
    ['缺 DATABASE_URL', {}],
    ['空 DATABASE_URL', { ...BASE, DATABASE_URL: '' }],
    ['端口 0', { ...BASE, TRACE_RECEIVER_PORT: '0' }],
    ['batchMax 0', { ...BASE, TRACE_BATCH_MAX: '0' }],
    ['flushInterval 低于下界', { ...BASE, TRACE_FLUSH_INTERVAL_MS: '50' }],
    ['queueMax 低于下界', { ...BASE, TRACE_QUEUE_MAX: '10' }],
    ['非法 log level', { ...BASE, LOG_LEVEL: 'loud' }],
    ['非法 otel mode', { ...BASE, OTEL_TRACES_MODE: 'zipkin' }],
    ['endpoint 非 URL', { ...BASE, OTEL_EXPORTER_OTLP_ENDPOINT: 'not-a-url' }],
  ])('%s', (_name, env) => {
    expect(() => parse(env)).toThrow(z.ZodError);
  });
});

describe('令牌三道门 + 生产强制(修正确保闸门真的会触发)', () => {
  it('缺令牌 → fail-fast(任意环境——S10:不再只按 NODE_ENV 字面量推断)', () => {
    expect(() => parse({ ...BASE, NODE_ENV: 'production' })).toThrow(/TRACE_RECEIVER_TOKEN/);
    // 非 production(裸跑/staging/uat/未设)同样拒绝:装配遗漏不再静默敞口
    expect(() => parse({ ...BASE })).toThrow(/TRACE_RECEIVER_TOKEN/);
    expect(() => parse({ ...BASE, NODE_ENV: 'development' })).toThrow(/TRACE_RECEIVER_TOKEN/);
  });

  it('TRACE_RECEIVER_OPEN=true 显式逃生门(隔离本机开发)→ 无令牌放行;配强令牌 → 通过', () => {
    expect(
      parse({ ...BASE, TRACE_RECEIVER_OPEN: 'true', NODE_ENV: 'development' }).receiverToken,
    ).toBeUndefined();
    expect(
      parse({ ...BASE, NODE_ENV: 'production', TRACE_RECEIVER_TOKEN: STRONG_TOKEN }).receiverToken,
    ).toBe(STRONG_TOKEN);
    // OPEN 只认显式 true——false/垃圾值不放行
    expect(() => parse({ ...BASE, TRACE_RECEIVER_OPEN: 'false' })).toThrow(/TRACE_RECEIVER_TOKEN/);
    expect(() => parse({ ...BASE, TRACE_RECEIVER_OPEN: '1' })).toThrow(z.ZodError); // 非法布尔形态直接拒
  });

  it.each([
    ['短于 16', 'short'],
    ['已知弱值', 'password'],
    ['弱值 change-me', 'change-me'],
    ['字符多样性不足', 'aaaaaaaaaaaaaaaaaaaa'],
  ])('%s 被拒', (_name, token) => {
    expect(() => parse({ ...BASE, TRACE_RECEIVER_TOKEN: token })).toThrow(z.ZodError);
  });
});
