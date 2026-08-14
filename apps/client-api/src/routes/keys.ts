import { Hono } from 'hono';
import { eq, and, gt, sql, desc } from 'drizzle-orm';
import { apiKeys, userSubscriptions } from '@ai-gateway/db/schema';
import { z } from 'zod';
import {
  HttpError,
  generateApiKey,
  intParam,
  invalidateKeyAuthCache,
  jsonBody,
  limitOffset,
  maskKey,
  paginateQuery,
  paginationQuerySchema,
  parsePagination,
  query,
  recordAudit,
  sha256Hex,
} from '@ai-gateway/http';
import type { ClientEnv } from '@ai-gateway/identity';
import type { ClientServices } from '../services/index.js';

/**
 * 用户面板：虚拟 Key 管理（api-contract §4.2）。
 *
 *   - GET /：自己的 Key 列表（只显示脱敏预览，不回显明文）
 *   - POST /：创建，明文 Key 仅在响应中出现一次（落库的是 SHA-256 哈希）
 *   - PATCH /:id：改名/限流/过期调整（不可改 Key 本身）
 *   - DELETE /:id：吊销（清网关鉴权缓存，立即失效）
 *
 * 安全（data-model §3.3）：
 *   - 明文 Key 不落库，只存 key_hash + key_preview
 *   - 所有操作限定 user_id = session.userId（防越权）
 */

const keyCreateSchema = z.object({
  name: z.string().min(1).max(64),
  remark: z.string().max(255).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  rpmLimit: z.number().int().min(1).nullable().optional(),
  tpmLimit: z.number().int().min(1).nullable().optional(),
  /** Key 级每日花费上限（元，>=0），null=不限。团队团员自助封顶。 */
  dailySpendLimit: z.number().min(0).nullable().optional(),
});

const keyUpdateSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  remark: z.string().max(255).nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  rpmLimit: z.number().int().min(1).nullable().optional(),
  tpmLimit: z.number().int().min(1).nullable().optional(),
  /** Key 级每日花费上限（元，>=0），null=不限。 */
  dailySpendLimit: z.number().min(0).nullable().optional(),
});

export function keyRoutes(s: ClientServices): Hono<ClientEnv> {
  return new Hono<ClientEnv>()

    // 列表
    .get('/', query(paginationQuerySchema), async (c) => {
      const session = c.get('session');
      const p = parsePagination(c.req.valid('query'));
      const { limit, offset } = limitOffset(p);
      const where = eq(apiKeys.userId, session.userId);
      const result = await paginateQuery(
        p,
        s.db
          .select({
            id: apiKeys.id,
            keyPreview: apiKeys.keyPreview,
            name: apiKeys.name,
            remark: apiKeys.remark,
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
          .orderBy(desc(apiKeys.createdAt))
          .limit(limit)
          .offset(offset),
        s.db.select({ count: sql<number>`count(*)::int` }).from(apiKeys).where(where),
      );
      return c.json(result);
    })

    // 创建（明文 Key 仅此一次回显）
    .post('/', jsonBody(keyCreateSchema), async (c) => {
      const session = c.get('session');
      const body = c.req.valid('json');

      // 席位 = Key 名额：必须有有效订阅，且活跃 Key 数 < 订阅席位（个人=1，企业=席位）。
      // 事务内锁定订阅行（FOR UPDATE）串行化同席位并发建 Key，杜绝「数了再插」超发。
      const plaintext = generateApiKey();
      const created = await s.db.transaction(async (tx) => {
        const subs = await tx
          .select({ id: userSubscriptions.id, quantity: userSubscriptions.quantity })
          .from(userSubscriptions)
          .where(
            and(
              eq(userSubscriptions.userId, session.userId),
              eq(userSubscriptions.status, 0),
              gt(userSubscriptions.endAt, new Date()),
            ),
          )
          .limit(1)
          .for('update');
        const sub = subs[0];
        if (!sub) throw new HttpError(402, 'SUBSCRIPTION_REQUIRED', '请先订阅套餐后再创建 Key');
        const activeRow = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(apiKeys)
          .where(and(eq(apiKeys.userId, session.userId), eq(apiKeys.status, 0)));
        if (Number(activeRow[0]?.count ?? 0) >= sub.quantity) {
          throw new HttpError(409, 'SEATS_FULL', `席位已满（${sub.quantity}），请扩容或先删除现有 Key`);
        }
        const [row] = await tx
          .insert(apiKeys)
          .values({
            keyHash: sha256Hex(plaintext),
            keyPreview: maskKey(plaintext),
            userId: session.userId,
            name: body.name,
            remark: body.remark ?? null,
            expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
            rpmLimit: body.rpmLimit ?? null,
            tpmLimit: body.tpmLimit ?? null,
            // numeric 列接受字符串；number → string 对齐 schema 类型
            dailySpendLimit: body.dailySpendLimit == null ? null : String(body.dailySpendLimit),
            status: 0,
          })
          .returning({ id: apiKeys.id, name: apiKeys.name });
        return row!;
      });
      await recordAudit(s.db, {
        actor: 'user',
        action: 'api_key.create',
        targetType: 'api_key',
        targetId: created.id,
      });
      // 明文 key 只在此响应中下发
      return c.json({ ...created, key: plaintext }, 201);
    })

    // 轮换（个人「刷新」）：原子吊销旧 Key + 建新 Key，沿用旧 Key 的 name/限流，明文只回显一次。
    .post('/:id/rotate', async (c) => {
      const session = c.get('session');
      const id = intParam(c, 'id');
      const [oldKey] = await s.db
        .select({
          keyHash: apiKeys.keyHash,
          name: apiKeys.name,
          remark: apiKeys.remark,
          expiresAt: apiKeys.expiresAt,
          rpmLimit: apiKeys.rpmLimit,
          tpmLimit: apiKeys.tpmLimit,
          dailySpendLimit: apiKeys.dailySpendLimit,
        })
        .from(apiKeys)
        .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, session.userId), eq(apiKeys.status, 0)))
        .limit(1);
      if (!oldKey) throw new HttpError(404, 'API_KEY_NOT_FOUND', 'Key 不存在、无权操作或已吊销');

      const plaintext = generateApiKey();
      const created = await s.db.transaction(async (tx) => {
        const [revoked] = await tx
          .update(apiKeys)
          .set({ status: 1, revokedAt: new Date() })
          .where(and(eq(apiKeys.id, id), eq(apiKeys.status, 0)))
          .returning({ id: apiKeys.id });
        if (!revoked) throw new HttpError(404, 'API_KEY_NOT_FOUND', 'Key 不存在或已吊销');
        const [row] = await tx
          .insert(apiKeys)
          .values({
            keyHash: sha256Hex(plaintext),
            keyPreview: maskKey(plaintext),
            userId: session.userId,
            name: oldKey.name,
            remark: oldKey.remark,
            expiresAt: oldKey.expiresAt,
            rpmLimit: oldKey.rpmLimit,
            tpmLimit: oldKey.tpmLimit,
            dailySpendLimit: oldKey.dailySpendLimit,
            status: 0,
          })
          .returning({ id: apiKeys.id, name: apiKeys.name });
        return row!;
      });

      await recordAudit(s.db, {
        actor: 'user',
        action: 'api_key.rotate',
        targetType: 'api_key',
        targetId: created.id,
      });
      await invalidateKeyAuthCache(s.redis, [oldKey.keyHash]);
      return c.json({ ...created, key: plaintext }, 201);
    })

    // 更新（不可改 Key 本身）
    .patch('/:id', jsonBody(keyUpdateSchema), async (c) => {
      const session = c.get('session');
      const id = intParam(c, 'id');
      const body = c.req.valid('json');
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
        .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, session.userId))) // 限定自己的 Key
        // 只回显脱敏字段（与列表一致），绝不回显 keyHash；明文 Key 早在创建后就不可再取回
        .returning({
          id: apiKeys.id,
          keyPreview: apiKeys.keyPreview,
          name: apiKeys.name,
          remark: apiKeys.remark,
          expiresAt: apiKeys.expiresAt,
          rpmLimit: apiKeys.rpmLimit,
          tpmLimit: apiKeys.tpmLimit,
          dailySpendLimit: apiKeys.dailySpendLimit,
          status: apiKeys.status,
          lastUsedAt: apiKeys.lastUsedAt,
          createdAt: apiKeys.createdAt,
        });
      if (!updated) throw new HttpError(404, 'API_KEY_NOT_FOUND', 'Key 不存在或无权操作');
      return c.json(updated);
    })

    // 吊销（清网关鉴权缓存，立即失效）
    .delete('/:id', async (c) => {
      const session = c.get('session');
      const id = intParam(c, 'id');
      const [revoked] = await s.db
        .update(apiKeys)
        .set({ status: 1, revokedAt: new Date() })
        .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, session.userId), eq(apiKeys.status, 0)))
        .returning({ id: apiKeys.id, keyHash: apiKeys.keyHash });
      if (!revoked) throw new HttpError(404, 'API_KEY_NOT_FOUND', 'Key 不存在、无权操作或已吊销');
      await recordAudit(s.db, {
        actor: 'user',
        action: 'api_key.revoke',
        targetType: 'api_key',
        targetId: id,
      });
      // 清 gateway 鉴权缓存（auth:key:{hash}）→ 吊销立即生效，无需等 60s TTL
      await invalidateKeyAuthCache(s.redis, [revoked.keyHash]);
      return c.json({ ok: true });
    });
}
