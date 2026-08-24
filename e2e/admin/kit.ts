/**
 * admin 旅程 e2e 装置（重构方案 §9/P5：跨进程旅程归仓根 e2e/）。
 * 形态与 e2e/gateway/kit 同院：进程内全真装配（真实 PG 池 + 真实秘密键 + identity
 * 签发真 admin-realm 令牌）+ @hono/node-server 真监听——断言打真实 HTTP 面。
 * 差异（vs app 包内 real 冒烟）：本 kit 只组装配与属主事实,旅程断言全在测试文件；
 * 依赖闭包经 apps/admin-api（含 identity——gateway 闭包没有）。
 * 数据卫生：旅程专属行以 e2e- 前缀命名并就地退役;e2e 专属用户经 accounts facade
 * provision（真实账本行保留——v1 e2e-money 同口径,审计可追溯）。
 */
import { serve, type ServerType } from '@hono/node-server';
import { asc } from 'drizzle-orm';
import { admins, closeDb, createDb, ping } from '@tillgate/db';
import { loadAdminApiConfig } from '../../apps/admin-api/src/config';
import { assembleAdminApi, type AdminApiAssembly } from '../../apps/admin-api/src/assembly';
import { createAdminApp } from '../../apps/admin-api/src/app';

// 测试内替代非空断言的统一收窄手段：值缺失时抛出带定位信息的错误而非静默断言
// （本分区与 cross-app/ 共用——后者经 ../admin/kit.js 导入）
export function defined<T>(value: T | null | undefined, label = 'value'): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}

const E2E_SECRET = 'e2e-admin-jwt-secret-0123456789-abcdef';
const E2E_ENC = 'e2e-admin-encryption-key-0123456789';
const E2E_PEPPER = 'e2e-admin-pepper-0123456789';

export const E2E_URL = process.env.DB_TEST_URL ?? process.env.DATABASE_URL;

export interface E2EAdminWorld {
  base: string;
  token: string;
  adminId: number;
  server: ServerType;
  assembly: AdminApiAssembly;
  /** 旅程专属用户（真实账本行,零真实用户污染） */
  provisionUser(): Promise<{ id: number; email: string }>;
}

/** 带会话头的 HTTP 调用(响应体解析为对象) */
export async function call(
  world: E2EAdminWorld,
  path: string,
  init: RequestInit & { idempotencyKey?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${world.token}`);
  if (init.idempotencyKey !== undefined) headers.set('idempotency-key', init.idempotencyKey);
  const res = await fetch(`${world.base}${path}`, { ...init, headers });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

/** PG 可达探测（不可达 → null 优雅 skip） */
async function adminDbReachable(url: string): Promise<boolean> {
  const probe = createDb({
    url,
    poolMax: 2,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 3_000,
    maxUses: 100,
  });
  try {
    await ping(probe);
    return true;
  } catch {
    return false;
  } finally {
    await closeDb(probe);
  }
}

/** admin app 装配接线（options 平铺——纯装配数据搬运，从 setup 工厂拆出控函数行数） */
function buildAdminAppOptions(
  assembly: AdminApiAssembly,
  config: ReturnType<typeof loadAdminApiConfig>,
): Parameters<typeof createAdminApp>[0] {
  return {
    pingDb: () => ping(assembly.db),
    logger: assembly.logger,
    sessions: {
      validate: assembly.identity.sessions.validate,
      owner: (subjectId) => assembly.controlPlane.admins.findAccess(subjectId),
    },
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
    loginAudit: assembly.loginAudit,
    sessionTtlSec: config.sessionTtlSec,
    corsOrigins: config.corsOrigins,
    bodyLimitBytes: config.bodyLimitBytes,
    now: () => new Date(),
  };
}

/** admin 旅程专用 env 布置（密钥/日志口径；P2 后 JWT_SECRET 是词表一致性的
 *  必填键——client 同钥签用户会话，REDIS_URL 同为必填（爆破双闸）——外部注入,不在此造默认 */
function applyAdminJourneyEnv(): void {
  process.env.ADMIN_JWT_SECRET = E2E_SECRET;
  process.env.JWT_SECRET ??= 'e2e-admin-user-jwt-secret-0123456789';
  process.env.ENCRYPTION_KEY = E2E_ENC;
  process.env.IDENTITY_CODE_PEPPER = E2E_PEPPER;
  process.env.OTEL_TRACES_MODE = 'off';
  process.env.LOG_LEVEL = 'error';
}

export async function setupE2EAdmin(): Promise<E2EAdminWorld | null> {
  if (E2E_URL === undefined || E2E_URL === '') return null;
  if (!(await adminDbReachable(E2E_URL))) return null;

  applyAdminJourneyEnv();

  const config = loadAdminApiConfig();
  const assembly = assembleAdminApi(config);

  // 进货行/审计行 admin_id 外键指向 admins——令牌 subject 必须是真实管理员
  const adminRows = await assembly.db
    .select({ id: admins.id })
    .from(admins)
    .orderBy(asc(admins.id))
    .limit(1);
  if (adminRows.length === 0) {
    await closeDb(assembly.db);
    return null;
  }
  const adminId = defined(adminRows[0], 'admins row').id;
  const token = await assembly.identity.sessions.sign({
    realm: 'admin',
    subjectId: adminId,
    ttlSec: 600,
  });

  const app = createAdminApp(buildAdminAppOptions(assembly, config));

  const server = serve({ fetch: app.fetch, port: 0 });
  const port = (server.address() as { port: number } | null)?.port ?? 0;
  const world: E2EAdminWorld = {
    base: `http://127.0.0.1:${port}`,
    token,
    adminId,
    server,
    assembly,
    async provisionUser() {
      const user = await assembly.accounts.provisionLocalAccount({
        email: `e2e-admin-${Date.now()}@e2e.invalid`,
        displayName: 'e2e-admin-journey',
      });
      return { id: user.id, email: user.email ?? '' };
    },
  };
  return world;
}

export async function teardownE2EAdmin(world: E2EAdminWorld): Promise<void> {
  await new Promise<void>((resolve) => {
    world.server.close(() => resolve());
  });
  await closeDb(world.assembly.db);
}

export const jsonHeaders = { 'content-type': 'application/json' };
