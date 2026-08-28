import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, createDb, ping, type Db } from '@tillgate/db';
import { assembleAdminApi } from '../src/assembly';
import { loadAdminApiConfig } from '../src/config';
import { createAdminApp } from '../src/app';

/**
 * 真实 PG 冒烟(默认门禁按文件名排除;DATABASE_URL 不可达优雅跳过):
 * 装配 → 探针(经真实 pg 池) → 收口。业务行为等价由能力包 real 测试与
 * 契约测试承担——本文件只锁「装配件在真实依赖形态下可启动」。
 */

let db: Db | null = null;

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') return;
  const candidate = createDb({
    url,
    poolMax: 2,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 3_000,
  });
  try {
    await ping(candidate);
    db = candidate;
  } catch {
    await closeDb(candidate);
  }
});

afterAll(async () => {
  if (db !== null) await closeDb(db);
});

describe('admin-api 真实 PG 冒烟', () => {
  it('装配 + readyz 经真实 pg 池(DATABASE_URL 不可达时静默通过)', async () => {
    if (db === null) return;
    // 冒烟自备测试秘密值(只补缺——部署真实值经 .env 注入;此处仅保证装配形状合法)
    process.env.ADMIN_JWT_SECRET ??= 'real-smoke-admin-jwt-secret-0123456789';
    process.env.ENCRYPTION_KEY ??= 'real-smoke-encryption-key-0123456789';
    process.env.IDENTITY_CODE_PEPPER ??= 'real-smoke-pepper-0123456789';
    const config = loadAdminApiConfig();
    const assembly = await assembleAdminApi(config);
    try {
      const app = createAdminApp({
        pingDb: () => ping(assembly.db),
        logger: assembly.logger,
        sessions: assembly.identity.sessions,
        accounts: assembly.accounts,
        wallet: assembly.billing.wallet,
        operations: assembly.operations,
        writeAudit: assembly.writeAuditInTx,
        subscriptions: assembly.billing.subscriptions,
        plans: assembly.billing.plans,
        redeemBatches: assembly.redeemBatches,
        review: assembly.billing.settlement.review,
        postAudit: assembly.postAudit,
        controlPlane: assembly.controlPlane,
        vendorCatalog: assembly.vendorCatalog,
        observability: assembly.observability,
        notifications: assembly.notifications,
        generationTasks: assembly.generationTasks,
        paymentAdmin: assembly.paymentAdmin,
        orderCloseReason: '管理员手动关闭',
        identity: assembly.identity,
        authGuards: assembly.authGuards,
        trustedProxyHops: config.trustedProxyHops,
        mailerConfigured: assembly.mailerConfigured,
        invites: assembly.invites,
        sendInviteLink: assembly.sendInviteLink,
        inviteLinkBase: assembly.inviteLinkBase,
        loginAudit: assembly.loginAudit,
        stepupAudit: assembly.stepupAudit,
        twoFactorAudit: assembly.twoFactorAudit,
        sessionTtlSec: config.sessionTtlSec,
        corsOrigins: [],
        bodyLimitBytes: 1024 * 1024,
        now: () => new Date(),
      });
      const ready = await app.request('/readyz');
      expect(ready.status).toBe(200);
      const unauthorized = await app.request('/v1/users');
      expect(unauthorized.status).toBe(401);
    } finally {
      await closeDb(assembly.db);
    }
  });
});
