import { afterAll, describe, expect, it } from 'vitest';
import { closeDb } from '@tillgate/db';
import { isBusinessError } from '@tillgate/errors';
import { observabilityErrors } from '@tillgate/observability';
import { assembleReceiver } from '../src/assembly';
import { loadTraceReceiverConfig } from '../src/config';

/**
 * 装配根规格:mode=otlp 缺端点在装配层启动期 fail-fast(单一所有者 initOtel——
 * config 只透传);off 模式全链装配可拆卸。
 */

const config = (overrides: Record<string, string | undefined> = {}) =>
  loadTraceReceiverConfig({
    DATABASE_URL: 'postgres://u:p@localhost:5432/unreachable-test',
    OTEL_TRACES_MODE: 'off', // 不启动 SDK;pg.Pool 惰性建连,不触库
    TRACE_RECEIVER_OPEN: 'true', // 测试显式开放逃生门(鉴权语义另有 config 测试锁定)
    ...overrides,
  } as NodeJS.ProcessEnv);

describe('assembleReceiver', () => {
  const closers: Array<ReturnType<typeof assembleReceiver>> = [];
  afterAll(async () => {
    for (const assembled of closers) await closeDb(assembled.db).catch(() => {});
  });

  it('mode=otlp 缺端点 → 启动期抛 observability.otel_endpoint_missing', () => {
    try {
      assembleReceiver(config({ OTEL_TRACES_MODE: 'otlp' }));
      expect.unreachable('otel without endpoint must fail fast');
    } catch (error) {
      expect(isBusinessError(error)).toBe(true);
      expect((error as { code: string }).code).toBe(
        observabilityErrors.code('otel_endpoint_missing'),
      );
    }
  });

  it('off 模式:logger/otel/db/store/batcher 全链装配且 otel no-op', () => {
    const assembled = assembleReceiver(config());
    closers.push(assembled);
    expect(assembled.otel.mode).toBe('off');
    expect(assembled.otel.memory).toBeUndefined();
    expect(typeof assembled.store.writeBatch).toBe('function');
    // batcher 按配置接线:计数器零点
    expect(assembled.batcher.getStats()).toMatchObject({
      received: 0,
      droppedOverflow: 0,
      queueDepth: 0,
    });
  });
});
