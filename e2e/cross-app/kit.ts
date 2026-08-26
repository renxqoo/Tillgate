/**
 * 跨 app 生效链 e2e 装置（v1 admin-api e2e-cross-app 搬迁;P7 最后余项）：
 * client-api 真进程（client-journey harness——真 PG/Redis/HTTP + captureMailer
 * 抓验证码）+ admin-api 进程内全真装配（e2e/admin/kit——真 admin-realm 令牌）
 * **共库**——管理动作经真实 admin HTTP 面,用户面感知经真实 client HTTP 面。
 *
 * 与 v1 kit 的形态差异（装置差异,断言语义不改）：
 * - v1 双 app 均子进程 spawn → v2 client 真进程（harness）+ admin in-process
 *   （先例口径:e2e/admin 同院「进程内全真装配 + 真监听」）;
 * - v1 seedAdmin（插专用 admin 行 + 明文密码登录）→ v2 复用 admin kit 的
 *   「取库内首个 admins 行签发真令牌」;库内无行时 kit 先播种兜底行
 *   （client-journey seedRedeemCode 同款形状）——不再走密码登录面（admin 登录
 *   旅程 = P2 pending,此处会话门以真令牌直签锁定）;
 * - v1 trackE2E/cleanupE2E 全表清理 → v2 client-journey 的用户级 FK 逆序
 *   cleanupUsers + 播种行回收（共享库口径不变）。
 */
import { sql } from 'drizzle-orm';
import { createDb, closeDb } from '@tillgate/db';
import {
  apiClient,
  bootHarness,
  cleanupUsers,
  infraReady,
  registerUser,
  reservePort,
  type E2eHarness,
} from '../client-journey/harness.js';
import { setupE2EAdmin, teardownE2EAdmin, type E2EAdminWorld } from '../admin/kit.js';

/** 播种兜底 admin 行（库内已有真实管理员时不被取用——仅 admins 空表时生效） */
const SEEDED_ADMIN_EMAIL = 'e2e-crossapp-admin@tillgate.invalid';

export interface CrossAppWorld {
  client: E2eHarness;
  api: ReturnType<typeof apiClient>;
  admin: E2EAdminWorld;
  /** 旅程注册的用户（afterAll 统一 FK 逆序清理） */
  users: Array<{ id: number; email: string }>;
  teardown(): Promise<void>;
}

/** 统一库地址写回 env（两面共库的第一前提;bootHarness 与 admin kit 都读 process.env） */
function unifySharedDb(): string {
  const url = process.env.DB_TEST_URL ?? process.env.DATABASE_URL;
  if (url === undefined || url === '') {
    return '';
  }
  process.env.DATABASE_URL = url;
  return url;
}

/** admins 兜底播种（admin kit 取首个行签发;email 唯一冲突幂等） */
async function seedFallbackAdmin(url: string): Promise<void> {
  const db = createDb({
    url,
    poolMax: 1,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 3_000,
  });
  try {
    // admins 必填 email/password_hash（client-journey seedRedeemCode 同形状——占位哈希不可登录）
    await db.execute(
      sql`insert into admins (email, password_hash, status)
          values (${SEEDED_ADMIN_EMAIL}, 'e2e:unused:1:1:1', 0)
          on conflict (email) do nothing`,
    );
  } finally {
    await closeDb(db);
  }
}

export async function setupCrossApp(): Promise<CrossAppWorld | null> {
  // PG + Redis 双可达才跑（client-journey infraReady 口径——不可达优雅 skip）
  if (!(await infraReady())) return null;
  const url = unifySharedDb();
  if (url === '') return null;

  // admin config 必填项先行满足（admin kit 自设 ADMIN_JWT_SECRET/ENCRYPTION_KEY/
  // IDENTITY_CODE_PEPPER;JWT_SECRET 是 P2 后词表一致性的必填键——client 用同一
  // 密钥签发用户会话,REDIS_URL 两面共用）
  process.env.JWT_SECRET ??= 'e2e-crossapp-jwt-secret-0123456789abcdef';
  process.env.REDIS_URL ??= 'redis://localhost:6379';

  await seedFallbackAdmin(url);

  // client 真进程先起（config 先捕获——admin kit 随后覆写的 env 不影响已装配面）
  const client = await bootHarness({ appPort: await reservePort() });
  const api = apiClient(client.baseUrl);
  const admin = await setupE2EAdmin();
  if (admin === null) {
    await client.teardown();
    return null;
  }

  const users: Array<{ id: number; email: string }> = [];
  return {
    client,
    api,
    admin,
    users,
    async teardown() {
      // 用户级 FK 逆序清理（client-journey 装置）——两面共用同一库,一次清完
      await cleanupUsers(client.assembly.db, users);
      await client.assembly.db
        .execute(sql`delete from admins where email = ${SEEDED_ADMIN_EMAIL}`)
        .catch(() => {});
      await teardownE2EAdmin(admin);
      await client.teardown();
    },
  };
}

export { apiClient, registerUser };
