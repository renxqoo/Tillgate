import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeDb } from '@tillgate/db';
import { assembleAdminApi } from '../src/assembly';
import { loadAdminApiConfig } from '../src/config';
import { createAdminShutdown } from '../src/shutdown';

/**
 * 装配契约:启动期 fail-fast(otlp 缺端点/秘密非法在 DB 连接前触发——pg 池惰性);
 * 全量 facade 构造零连接;停机组装件委托 runtime createShutdown。
 */

const BASE: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/tillgate-test',
  ADMIN_JWT_SECRET: 'admin-jwt-secret-0123456789-abcdef',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'user-jwt-secret-0123456789-abcdef',
  ENCRYPTION_KEY: 'encryption-key-0123456789-abcdef',
  IDENTITY_CODE_PEPPER: 'pepper-0123-9abcd',
};

describe('assembleAdminApi', () => {
  // 「otlp 缺端点 fail-fast」用例随端点内置缺省化移除——schema 层已不可构造该形态
  it('合法配置构造全量 facade(零连接;桥接件就位;loginAudit 分支矩阵)', async () => {
    const assembly = await assembleAdminApi(loadAdminApiConfig({ ...BASE }), {
      platformCurrency: 'CNY',
    });
    try {
      expect(assembly.identity.sessions.validate).toBeTypeOf('function');
      expect(assembly.billing.wallet.credit).toBeTypeOf('function');
      expect(assembly.billing.subscriptions.grantPack).toBeTypeOf('function');
      expect(assembly.accounts.adminListUsers).toBeTypeOf('function');
      expect(assembly.controlPlane.providers.list).toBeTypeOf('function');
      expect(assembly.observability.traces.recent).toBeTypeOf('function');
      expect(assembly.operations.run).toBeTypeOf('function');
      expect(assembly.writeAuditInTx).toBeTypeOf('function');

      // loginAudit 形状适配分支全矩阵:adminId/ip/email/twoFactor 有无组合
      // (writeAudit 落库失败被 sink 吞掉并记日志——分支在回调内求值,无需真连接)
      await assembly.loginAudit({
        action: 'auth.login.success',
        adminId: 9,
        ip: '1.2.3.4',
        email: 'a@b.c',
        twoFactor: true,
      });
      await assembly.loginAudit({
        action: 'auth.login.invalid_credentials',
        adminId: null,
        ip: null,
        email: undefined,
        twoFactor: undefined,
      });
      await expect(
        assembly.loginAudit({ action: 'auth.login.2fa_challenge', adminId: 4, ip: null }),
      ).resolves.toBeUndefined();

      // 同底座其余三桥:best-effort 契约 = 不抛(落库失败记日志不反噬)
      await expect(
        assembly.stepupAudit({ action: 'settings.stepup.failed', adminId: 2, ip: '5.6.7.8' }),
      ).resolves.toBeUndefined();
      await expect(
        assembly.twoFactorAudit({ adminId: 3, enabledFrom: false, enabledTo: true }),
      ).resolves.toBeUndefined();
      await expect(
        assembly.postAudit({
          actor: 'admin',
          adminId: 1,
          action: 'probe.action',
          targetType: 'user',
          targetId: 7,
          detail: null,
        }),
      ).resolves.toBeUndefined();
    } finally {
      void closeDb(assembly.db);
    }
  });

  it('assembly 纯组装:无 process.exit(启动策略在 startup-rbac.ts,exit 属进程生命周期层)', () => {
    const src = readFileSync(join(import.meta.dirname, '../src/assembly.ts'), 'utf8');
    expect(src).not.toContain('process.exit');
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
    const redisQuit = vi.fn(async () => {
      order.push('redis');
    });
    const shutdown = createAdminShutdown({
      // 形状适配:runtime 只需 close(callback) / shutdown() / quit() / db.$client.end()
      server: { close } as never,
      otel: { shutdown: otelShutdown } as never,
      redis: { quit: redisQuit },
      db: { $client: { end: dbEnd } } as never,
      graceMs: 60_000,
      logger: logger as never,
      exit,
    });
    expect(typeof shutdown).toBe('function');
    shutdown('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(order).toEqual(['server', 'otel', 'redis', 'db', 'exit:0']);
  });
});
