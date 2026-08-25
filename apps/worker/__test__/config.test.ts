/**
 * worker 配置规格（v1 config/config-resolve 双测试文件合一——v2 单入口）：
 * 缺省全显式、布尔双形态、非法 fail-closed、必填缺失 fail-closed、
 * 静音开关、SMTP 三要素缺一不装配。
 */
import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from '../src/config';

const base = (overrides: Record<string, string | undefined> = {}) =>
  ({
    DATABASE_URL: 'postgres://u:p@localhost:5432/worker-test',
    CHANNEL_API_KEY_ENCRYPTION: 'wk3y-zx9q'.repeat(4),
    ...overrides,
  }) as NodeJS.ProcessEnv;

describe('worker 配置 fail-closed', () => {
  it('缺省全显式（部署缺省唯一真相在本层）', () => {
    const config = loadWorkerConfig(base());
    expect(config.settle).toMatchObject({
      batchSize: 20,
      claimLeaseMs: 60_000,
      intervalMs: 30_000,
      wake: true,
    });
    expect(config.recover).toMatchObject({ intervalMs: 15_000, batchSize: 50 });
    expect(config.generation).toMatchObject({
      intervalMs: 5_000,
      batchSize: 20,
      leaseMs: 30_000,
      expireReason: '任务超时（TTL 到期）',
    });
    expect(config.referral).toMatchObject({ intervalMs: 3_600_000, backfillDays: 7 });
    expect(config.notify).toMatchObject({ enabled: true, intervalMs: 15_000 });
    expect(config.notify.dispatch).toMatchObject({ claimLeaseMs: 60_000, maxAttempts: 3 });
    expect(config.reconcile.intervalMs).toBe(3_600_000);
    expect(config.partition).toMatchObject({
      intervalMs: 3_600_000,
      traceRetentionDays: 7,
      requestLogRetentionDays: 90,
    });
    expect(config.balanceLowThreshold).toBe('5');
    expect(config.health).toEqual({ port: 8792, token: undefined });
    expect(config.shutdownGraceMs).toBe(15_000);
  });

  it('生产启动不再要求上游白名单 env（ADR-0010：出口信任锚在运营面）', () => {
    expect(() => loadWorkerConfig(base({ NODE_ENV: 'production' }))).not.toThrow();
  });

  it('布尔双形态：字符串 false 关闭唤醒/通知（v1 strictBoolean 同形）', () => {
    const config = loadWorkerConfig(
      base({ WORKER_SETTLE_WAKE: 'false', WORKER_NOTIFY_ENABLED: 'false' }),
    );
    expect(config.settle.wake).toBe(false);
    expect(config.notify.enabled).toBe(false);
  });

  it('数值非法 fail-closed（zod 拒绝后不落缺省）', () => {
    expect(() => loadWorkerConfig(base({ WORKER_BATCH_SIZE: '0' }))).toThrow();
    expect(() => loadWorkerConfig(base({ WORKER_NOTIFY_CLAIM_LEASE_MS: '100' }))).toThrow();
    expect(() => loadWorkerConfig(base({ WORKER_BALANCE_LOW_THRESHOLD: '-1' }))).toThrow();
  });

  it('必填缺失 fail-closed：DATABASE_URL / CHANNEL_API_KEY_ENCRYPTION / 弱密钥', () => {
    expect(() => loadWorkerConfig(base({ DATABASE_URL: undefined }))).toThrow();
    expect(() => loadWorkerConfig(base({ CHANNEL_API_KEY_ENCRYPTION: undefined }))).toThrow();
    expect(() => loadWorkerConfig(base({ CHANNEL_API_KEY_ENCRYPTION: 'secret' }))).toThrow();
  });

  it('OTEL mode=otlp 缺端点 fail-closed', () => {
    expect(() => loadWorkerConfig(base({ OTEL_TRACES_MODE: 'otlp' }))).toThrow();
    expect(() =>
      loadWorkerConfig(
        base({ OTEL_TRACES_MODE: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://o:4318' }),
      ),
    ).not.toThrow();
  });

  it('SMTP 三要素缺一 = 不装配（email 渠道 fail-closed 的装配前提）', () => {
    expect(loadWorkerConfig(base()).smtp).toBeNull();
    expect(loadWorkerConfig(base({ SMTP_HOST: 'smtp.test' })).smtp).toBeNull();
    expect(
      loadWorkerConfig(base({ SMTP_HOST: 'smtp.test', SMTP_USER: 'u', SMTP_PASS: 'p' })).smtp,
    ).toMatchObject({ host: 'smtp.test', port: 465, user: 'u', pass: 'p' });
  });
});
