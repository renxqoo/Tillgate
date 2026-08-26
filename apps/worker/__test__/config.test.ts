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
    REDIS_URL: 'redis://:secret@localhost:6379/0',
    ...overrides,
  }) as NodeJS.ProcessEnv;

describe('worker 配置 fail-closed', () => {
  it('Redis 全缺（WORKER_REDIS_URL/REDIS_URL 皆无）→ fail-closed 抛错（BullMQ 调度无队列不可用）', () => {
    expect(() => loadWorkerConfig(base({ REDIS_URL: undefined }))).toThrow(/WORKER_REDIS_URL/);
  });

  it('WORKER_REDIS_URL 优先于 REDIS_URL', () => {
    const config = loadWorkerConfig(
      base({ WORKER_REDIS_URL: 'redis://:dedicated@localhost:6380/2' }),
    );
    expect(config.settle.bullmq.redisUrl).toBe('redis://:dedicated@localhost:6380/2');
  });

  it('缺省全显式（部署缺省唯一真相在本层）', () => {
    const config = loadWorkerConfig(base());
    expect(config.settle).toMatchObject({
      batchSize: 20,
      claimLeaseMs: 60_000,
      intervalMs: 30_000,
      wake: true,
    });
    // BullMQ 调度旋钮(2026-08-26 增量):缺省值唯一真相在此锁死
    expect(config.settle.bullmq).toEqual({
      redisUrl: 'redis://:secret@localhost:6379/0',
      prefix: '{bull}',
      concurrency: 8,
      maxAttempts: 10,
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
});
