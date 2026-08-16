import { eq, and, sql } from 'drizzle-orm';
import { apps } from '@ai-gateway/db/schema';
import { z } from 'zod';
import {
  appStatusCache,
  generateClientId,
  generateClientSecret,
  HttpError,
  recordAudit,
  paginateQuery,
  listQuerySchema,
  buildList,
  countAll,
  sha256Hex,
} from '@ai-gateway/http';
import type { ClientServices } from './index.js';
import { assertCanUseSubscription } from './subscription-guard.js';

/**
 * 用户面板：应用（App）管理（api-contract §4.2）。
 *
 * 安全（data-model §3.2）：
 *   - client_secret 只存 SHA-256 哈希，明文仅创建/轮换时下发
 *   - 轮换使用事务 + FOR UPDATE 行锁，防并发 rotate 竞争
 */

export interface AppCreateInput {
  name: string;
  description?: string;
  subscriptionId?: number | null;
  scope?: {
    models?: string[];
    rpm?: number;
    tpm?: number;
  } | null;
}

export async function listMyApps(s: ClientServices, userId: number, input: z.infer<typeof listQuerySchema>) {
  const { page, limit, offset, where, orderBy } = buildList(input, {
    search: [apps.name, apps.description],
    conditions: [eq(apps.userId, userId)],
    sort: {
      by: { id: apps.id, name: apps.name, status: apps.status, createdAt: apps.createdAt, rotatedAt: apps.rotatedAt },
      fallback: 'createdAt',
      tiebreaker: apps.id,
    },
  });
  return paginateQuery(
    page,
    s.db
      .select({
        id: apps.id,
        appId: apps.appId,
        clientId: apps.clientId,
        name: apps.name,
        description: apps.description,
        subscriptionId: apps.subscriptionId,
        scope: apps.scope,
        status: apps.status,
        createdAt: apps.createdAt,
        rotatedAt: apps.rotatedAt,
      })
      .from(apps)
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    countAll(s.db, apps, where),
  );
}

/** 创建（client_secret 仅在返回值中出现一次；100 个配额带 advisory 锁防并发超限） */
export async function createMyApp(s: ClientServices, userId: number, input: AppCreateInput) {
  // W1：与 keys 同语义——绑定他人订阅在创建面即拒绝（授权侧另有兜底，纵深防御）
  if (input.subscriptionId != null) {
    await assertCanUseSubscription(s.db, userId, input.subscriptionId);
  }
  // 每用户 App 数量配额（防脚本化刷行）。advisory xact lock 按 (资源, user)
  // 串行化 count→insert，杜绝并发双击全部通过 count 后超限插入
  const clientId = generateClientId();
  const clientSecret = generateClientSecret();
  const created = await s.db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('quota.apps.user:' || ${userId}::text))`,
    );
    const [row_appCount] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(apps)
      .where(and(eq(apps.userId, userId), eq(apps.status, 0)));
    if (Number(row_appCount?.count ?? 0) >= 100) {
      throw new HttpError('APP_LIMIT_REACHED', '每人最多保留 100 个应用，请先禁用再创建');
    }
    const [row] = await tx
      .insert(apps)
      .values({
        appId: clientId, // 复用 client_id 作为对外 app_id（一期简化，二者同值）
        userId,
        clientId,
        clientSecretHash: sha256Hex(clientSecret),
        name: input.name,
        description: input.description ?? null,
        subscriptionId: input.subscriptionId ?? null,
        scope: input.scope ?? null,
        status: 0,
      })
      .returning({ id: apps.id, appId: apps.appId, clientId: apps.clientId, name: apps.name });
    return row!;
  });
  void recordAudit(s.db, {
    actor: 'user',
    action: 'app.create',
    targetType: 'app',
    targetId: created!.id,
  });
  return { ...created, clientSecret };
}

/** 禁用应用（已签发 JWT 立即失效） */
export async function disableMyApp(s: ClientServices, userId: number, id: number) {
  const [disabled] = await s.db
    .update(apps)
    .set({ status: 1 })
    .where(and(eq(apps.id, id), eq(apps.userId, userId), eq(apps.status, 0)))
    .returning({ id: apps.id, appId: apps.appId });
  if (!disabled) throw new HttpError('APP_NOT_FOUND', '应用不存在、无权操作或已禁用');
  void recordAudit(s.db, {
    actor: 'user',
    action: 'app.disable',
    targetType: 'app',
    targetId: id,
    detail: { appId: disabled.appId },
  });
  // 清 gateway 侧 App 状态缓存（app_status:{id}）→ 已签发 JWT 立即失效。
  // Redis 不可用时静默降级：靠 TTL 60s 兜底（gateway 下次查 DB 拿到 status=1）
  await s.redis.del(appStatusCache(id)).catch(() => {});
}

/** 轮换 secret（旧 secret 不能换新 JWT；不影响已签发 JWT） */
export async function rotateMyAppSecret(s: ClientServices, userId: number, id: number) {
  const newSecret = generateClientSecret();
  // 事务 + FOR UPDATE 行锁，防并发 rotate 竞争（两请求各返回 secret，后者覆盖前者）
  const [updated] = await s.db.transaction(async (tx) => {
    await tx.select({ id: apps.id }).from(apps)
      .where(and(eq(apps.id, id), eq(apps.userId, userId)))
      .for('update').limit(1);
    const [u] = await tx
      .update(apps)
      .set({ clientSecretHash: sha256Hex(newSecret), rotatedAt: new Date() })
      .where(and(eq(apps.id, id), eq(apps.userId, userId)))
      .returning({ id: apps.id });
    return [u];
  });
  if (!updated) throw new HttpError('APP_NOT_FOUND', '应用不存在或无权操作');
  void recordAudit(s.db, {
    actor: 'user',
    action: 'app.rotate_secret',
    targetType: 'app',
    targetId: id,
  });
  return newSecret;
}
