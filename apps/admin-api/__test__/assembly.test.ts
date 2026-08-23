import { describe, expect, it, vi } from 'vitest';
import { closeDb } from '@tokenlens/db';
import { assembleAdminApi } from '../src/assembly';
import { loadAdminApiConfig } from '../src/config';
import { createAdminShutdown } from '../src/shutdown';

/**
 * 装配契约:启动期 fail-fast(otlp 缺端点/秘密非法在 DB 连接前触发——pg 池惰性);
 * 全量 facade 构造零连接;停机组装件委托 runtime createShutdown。
 */

const BASE: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/tokenlens-test',
  ADMIN_JWT_SECRET: 'admin-jwt-secret-0123456789-abcdef',
  ENCRYPTION_KEY: 'encryption-key-0123456789-abcdef',
  IDENTITY_CODE_PEPPER: 'pepper-0123-9abcd',
};

describe('assembleAdminApi', () => {
  it('otlp 缺端点启动期 fail-fast(observability 单一所有者错误)', () => {
    expect(() =>
      assembleAdminApi(loadAdminApiConfig({ ...BASE, OTEL_TRACES_MODE: 'otlp' })),
    ).toThrowError(/endpoint/i);
  });

  it('合法配置构造全量 facade(零连接;桥接件就位)', () => {
    const assembly = assembleAdminApi(loadAdminApiConfig({ ...BASE }));
    try {
      expect(assembly.identity.sessions.validate).toBeTypeOf('function');
      expect(assembly.billing.wallet.credit).toBeTypeOf('function');
      expect(assembly.billing.subscriptions.grantPack).toBeTypeOf('function');
      expect(assembly.accounts.adminListUsers).toBeTypeOf('function');
      expect(assembly.controlPlane.providers.list).toBeTypeOf('function');
      expect(assembly.observability.traces.recent).toBeTypeOf('function');
      expect(assembly.operations.run).toBeTypeOf('function');
      expect(assembly.writeAuditInTx).toBeTypeOf('function');
    } finally {
      void closeDb(assembly.db);
    }
  });
});

describe('createAdminShutdown', () => {
  it('组装 runtime 停机编排(server→otel→db 收口→退出)', async () => {
    const order: string[] = [];
    const close = vi.fn((callback: () => void) => {
      order.push('server');
      callback();
    });
    const otelShutdown = vi.fn(async () => {
      order.push('otel');
    });
    const dbEnd = vi.fn(async () => {
      order.push('db');
    });
    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
    const exit = vi.fn((code: number) => {
      order.push(`exit:${code}`);
      return undefined as never;
    });
    const shutdown = createAdminShutdown({
      // 形状适配:runtime 只需 close(callback) / shutdown() / db.$client.end()
      server: { close } as never,
      otel: { shutdown: otelShutdown } as never,
      db: { $client: { end: dbEnd } } as never,
      graceMs: 60_000,
      logger: logger as never,
      exit,
    });
    expect(typeof shutdown).toBe('function');
    shutdown('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(order).toEqual(['server', 'otel', 'db', 'exit:0']);
  });
});
