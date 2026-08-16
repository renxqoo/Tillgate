import { eq, and, sql } from 'drizzle-orm';
import { apiKeys } from '@ai-gateway/db/schema';
import { z } from 'zod';
import {
  HttpError,
  generateApiKey,
  invalidateKeyAuthCache,
  maskKey,
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
 * 用户面板：虚拟 Key 管理（api-contract §4.2）。
 *
 * 计费来源（org/member 模型）：`subscriptionId` 显式绑定计费账户。
 *   - NULL = 余额；非空 = 扣该订阅额度（个人订阅 / 所属组织订阅）。
 * 创建时校验：用户须是该订阅 owner 或 active 成员，否则拒绝。
 */

export interface KeyCreateInput {
  name: string;
  remark?: string;
  subscriptionId?: number | null;
  expiresAt?: string | null;
  rpmLimit?: number | null;
  tpmLimit?: number | null;
  dailySpendLimit?: number | null;
}

export interface KeyPatch {
  name?: string;
  remark?: string | null;
  expiresAt?: string | null;
  rpmLimit?: number | null;
  tpmLimit?: number | null;
  dailySpendLimit?: number | null;
}

export async function listMyKeys(s: ClientServices, userId: number, input: z.infer<typeof listQuerySchema>) {
  const { page, limit, offset, where, orderBy } = buildList(input, {
    search: [apiKeys.name, apiKeys.remark],
    conditions: [eq(apiKeys.userId, userId)],
    sort: {
      by: { id: apiKeys.id, name: apiKeys.name, status: apiKeys.status, lastUsedAt: apiKeys.lastUsedAt, createdAt: apiKeys.createdAt },
      fallback: 'createdAt',
      tiebreaker: apiKeys.id,
    },
  });
  return paginateQuery(
    page,
    s.db
      .select({
        id: apiKeys.id,
        keyPreview: apiKeys.keyPreview,
        name: apiKeys.name,
        remark: apiKeys.remark,
        subscriptionId: apiKeys.subscriptionId,
        expiresAt: apiKeys.expiresAt,
        rpmLimit: apiKeys.rpmLimit,
        tpmLimit: apiKeys.tpmLimit,
        dailySpendLimit: apiKeys.dailySpendLimit,
        status: apiKeys.status,
        lastUsedAt: apiKeys.lastUsedAt,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    countAll(s.db, apiKeys, where),
  );
}

/** 创建（明文 Key 仅在返回值中出现一次；100 把配额带 advisory 锁防并发超限） */
export async function createMyKey(s: ClientServices, userId: number, input: KeyCreateInput) {
  const subscriptionId = input.subscriptionId ?? null;
  if (subscriptionId != null) {
    await assertCanUseSubscription(s.db, userId, subscriptionId);
  }

  // 每用户 Key 数量配额（防脚本化刷行；吊销的不占额）。
  // advisory xact lock 按 (资源, user) 串行化 count→insert，杜绝并发
  // 双击/重试全部通过 count 后超限插入（与账本授权同模式，锁随事务释放）
  const plaintext = generateApiKey();
  const created = await s.db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('quota.api_keys.user:' || ${userId}::text))`,
    );
    const [row_keyCount] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, userId), eq(apiKeys.status, 0)));
    if (Number(row_keyCount?.count ?? 0) >= 100) {
      throw new HttpError('KEY_LIMIT_REACHED', '每人最多保留 100 把有效 Key，请先吊销再创建');
    }
    const [row] = await tx
      .insert(apiKeys)
      .values({
        keyHash: sha256Hex(plaintext),
        keyPreview: maskKey(plaintext),
        userId,
        name: input.name,
        remark: input.remark ?? null,
        subscriptionId,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        rpmLimit: input.rpmLimit ?? null,
        tpmLimit: input.tpmLimit ?? null,
        // numeric 列接受字符串；number → string 对齐 schema 类型
        dailySpendLimit: input.dailySpendLimit == null ? null : String(input.dailySpendLimit),
        status: 0,
      })
      .returning({ id: apiKeys.id, name: apiKeys.name, subscriptionId: apiKeys.subscriptionId });
    return row!;
  });
  void recordAudit(s.db, {
    actor: 'user',
    action: 'api_key.create',
    targetType: 'api_key',
    targetId: created.id,
  });
  return { ...created, key: plaintext };
}

/** 轮换：原子吊销旧 Key + 建新 Key，沿用旧 Key 的配置，明文只回显一次 */
export async function rotateMyKey(s: ClientServices, userId: number, id: number) {
  const [oldKey] = await s.db
    .select({
      keyHash: apiKeys.keyHash,
      name: apiKeys.name,
      remark: apiKeys.remark,
      subscriptionId: apiKeys.subscriptionId,
      expiresAt: apiKeys.expiresAt,
      rpmLimit: apiKeys.rpmLimit,
      tpmLimit: apiKeys.tpmLimit,
      dailySpendLimit: apiKeys.dailySpendLimit,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId), eq(apiKeys.status, 0)))
    .limit(1);
  if (!oldKey) throw new HttpError('API_KEY_NOT_FOUND', 'Key 不存在、无权操作或已吊销');

  // 轮换沿用计费来源，但必须重过创建面同款订阅归属校验（L1）：
  // 订阅已到期/被移出组织时盲目沿用会把新 Key 绑到不可用订阅上。
  // 校验不过 → 降级为个人余额 Key（订阅侧变化不应阻断轮换）。
  let subscriptionId = oldKey.subscriptionId;
  if (subscriptionId != null) {
    try {
      await assertCanUseSubscription(s.db, userId, subscriptionId);
    } catch (error) {
      if (
        error instanceof HttpError &&
        (error.code === 'SUBSCRIPTION_NOT_FOUND' || error.code === 'SUBSCRIPTION_FORBIDDEN')
      ) {
        subscriptionId = null;
      } else {
        throw error;
      }
    }
  }

  const plaintext = generateApiKey();
  const created = await s.db.transaction(async (tx) => {
    const [revoked] = await tx
      .update(apiKeys)
      .set({ status: 1, revokedAt: new Date() })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.status, 0)))
      .returning({ id: apiKeys.id });
    if (!revoked) throw new HttpError('API_KEY_NOT_FOUND', 'Key 不存在或已吊销');
    const [row] = await tx
      .insert(apiKeys)
      .values({
        keyHash: sha256Hex(plaintext),
        keyPreview: maskKey(plaintext),
        userId,
        name: oldKey.name,
        remark: oldKey.remark,
        subscriptionId,
        expiresAt: oldKey.expiresAt,
        rpmLimit: oldKey.rpmLimit,
        tpmLimit: oldKey.tpmLimit,
        dailySpendLimit: oldKey.dailySpendLimit,
        status: 0,
      })
      .returning({ id: apiKeys.id, name: apiKeys.name, subscriptionId: apiKeys.subscriptionId });
    return row!;
  });

  void recordAudit(s.db, {
    actor: 'user',
    action: 'api_key.rotate',
    targetType: 'api_key',
    targetId: created.id,
  });
  await invalidateKeyAuthCache(s.redis, [oldKey.keyHash]);
  return { ...created, key: plaintext };
}

/** 更新（不可改 Key 本身 / 计费来源；限流/有效期收紧即时生效） */
export async function updateMyKey(s: ClientServices, userId: number, id: number, body: KeyPatch) {
  const update: Record<string, unknown> = {};
  if (body.name !== undefined) update.name = body.name;
  if (body.remark !== undefined) update.remark = body.remark;
  if (body.expiresAt !== undefined) update.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
  if (body.rpmLimit !== undefined) update.rpmLimit = body.rpmLimit;
  if (body.tpmLimit !== undefined) update.tpmLimit = body.tpmLimit;
  if (body.dailySpendLimit !== undefined)
    update.dailySpendLimit = body.dailySpendLimit == null ? null : String(body.dailySpendLimit);
  const [updated] = await s.db
    .update(apiKeys)
    .set(update)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId))) // 限定自己的 Key
    // 只回显脱敏字段（与列表一致），绝不回显 keyHash；明文 Key 早在创建后就不可再取回
    .returning({
      id: apiKeys.id,
      keyPreview: apiKeys.keyPreview,
      name: apiKeys.name,
      remark: apiKeys.remark,
      subscriptionId: apiKeys.subscriptionId,
      expiresAt: apiKeys.expiresAt,
      rpmLimit: apiKeys.rpmLimit,
      tpmLimit: apiKeys.tpmLimit,
      dailySpendLimit: apiKeys.dailySpendLimit,
      status: apiKeys.status,
      lastUsedAt: apiKeys.lastUsedAt,
      createdAt: apiKeys.createdAt,
    });
  if (!updated) throw new HttpError('API_KEY_NOT_FOUND', 'Key 不存在或无权操作');
  // 限流/有效期收紧必须即时生效：清网关鉴权缓存（auth:key TTL 60s，不主动清则延迟生效）
  if (
    body.rpmLimit !== undefined ||
    body.tpmLimit !== undefined ||
    body.dailySpendLimit !== undefined ||
    body.expiresAt !== undefined
  ) {
    const [keyRow] = await s.db
      .select({ keyHash: apiKeys.keyHash })
      .from(apiKeys)
      .where(eq(apiKeys.id, id))
      .limit(1);
    if (keyRow) await invalidateKeyAuthCache(s.redis, [keyRow.keyHash]);
  }
  return updated;
}

/** 吊销（清网关鉴权缓存，立即失效） */
export async function revokeMyKey(s: ClientServices, userId: number, id: number) {
  const [revoked] = await s.db
    .update(apiKeys)
    .set({ status: 1, revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId), eq(apiKeys.status, 0)))
    .returning({ id: apiKeys.id, keyHash: apiKeys.keyHash });
  if (!revoked) throw new HttpError('API_KEY_NOT_FOUND', 'Key 不存在、无权操作或已吊销');
  void recordAudit(s.db, {
    actor: 'user',
    action: 'api_key.revoke',
    targetType: 'api_key',
    targetId: id,
  });
  // 清 gateway 鉴权缓存（auth:key:{hash}）→ 吊销立即生效，无需等 60s TTL
  await invalidateKeyAuthCache(s.redis, [revoked.keyHash]);
}
