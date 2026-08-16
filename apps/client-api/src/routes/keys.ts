import { Hono } from 'hono';
import { eq, and, sql } from 'drizzle-orm';
import { apiKeys } from '@ai-gateway/db/schema';
import { z } from 'zod';
import {
  MONEY_MAX,
  HttpError,
  generateApiKey,
  intParam,
  invalidateKeyAuthCache,
  jsonBody,
  maskKey,
  paginateQuery,
  query,
  recordAudit,
  listQuerySchema,
  buildList,
  countAll,
  sha256Hex,
} from '@ai-gateway/http';
import type { ClientEnv } from '@ai-gateway/identity';
import type { ClientServices } from '../services/index.js';
import { assertCanUseSubscription } from '../services/subscription-guard.js';

/**
 * 用户面板：虚拟 Key 管理（api-contract §4.2）。
 *
 *   - GET /：自己的 Key 列表（只显示脱敏预览，不回显明文）
 *   - POST /：创建，明文 Key 仅在响应中出现一次（落库的是 SHA-256 哈希）
 *   - PATCH /:id：改名/限流/过期调整（不可改 Key 本身）
 *   - DELETE /:id：吊销（清网关鉴权缓存，立即失效）
 *
 * 计费来源（org/member 模型）：`subscriptionId` 显式绑定计费账户。
 *   - NULL = 余额；非空 = 扣该订阅额度（个人订阅 / 所属组织订阅）。
 * 创建时校验：用户须是该订阅 owner 或 active 成员，否则拒绝。
 */

const keyCreateSchema = z.object({
  name: z.string().min(1).max(64),
  remark: z.string().max(255).optional(),
  /** 计费来源：NULL=余额；非空=扣该订阅额度。 */
  subscriptionId: z.number().int().positive().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  rpmLimit: z.number().int().min(1).max(1_000_000).nullable().optional(),
  tpmLimit: z.number().int().min(1).max(1_000_000_000).nullable().optional(),
  /** Key 级每日花费上限（元，>=0），null=不限。 */
  dailySpendLimit: z.number().min(0).max(MONEY_MAX).nullable().optional(),
});

const keyUpdateSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  remark: z.string().max(255).nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  rpmLimit: z.number().int().min(1).max(1_000_000).nullable().optional(),
  tpmLimit: z.number().int().min(1).max(1_000_000_000).nullable().optional(),
  /** Key 级每日花费上限（元，>=0），null=不限。 */
  dailySpendLimit: z.number().min(0).max(MONEY_MAX).nullable().optional(),
});

export function keyRoutes(s: ClientServices): Hono<ClientEnv> {
  return new Hono<ClientEnv>()

    // 列表（q：名称/备注模糊搜索——此前前端发 q 后端不接收，搜索无效，R10 根治）
    .get('/', query(listQuerySchema), async (c) => {
      const session = c.get('session');
      const input = c.req.valid('query');
      const { page, limit, offset, where, orderBy } = buildList(input, {
        search: [apiKeys.name, apiKeys.remark],
        conditions: [eq(apiKeys.userId, session.userId)],
        sort: {
          by: { id: apiKeys.id, name: apiKeys.name, status: apiKeys.status, lastUsedAt: apiKeys.lastUsedAt, createdAt: apiKeys.createdAt },
          fallback: 'createdAt',
          tiebreaker: apiKeys.id,
        },
      });
      const result = await paginateQuery(
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
      return c.json(result);
    })

    // 创建（明文 Key 仅此一次回显）。
    .post('/', jsonBody(keyCreateSchema), async (c) => {
      const session = c.get('session');
      const body = c.req.valid('json');

      const subscriptionId = body.subscriptionId ?? null;
      if (subscriptionId != null) {
        await assertCanUseSubscription(s.db, session.userId, subscriptionId);
      }

      // 每用户 Key 数量配额（防脚本化刷行；吊销的不占额）。
      // advisory xact lock 按 (资源, user) 串行化 count→insert，杜绝并发
      // 双击/重试全部通过 count 后超限插入（与账本授权同模式，锁随事务释放）
      const plaintext = generateApiKey();
      const created = await s.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext('quota.api_keys.user:' || ${session.userId}::text))`,
        );
        const [row_keyCount] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(apiKeys)
          .where(and(eq(apiKeys.userId, session.userId), eq(apiKeys.status, 0)));
        if (Number(row_keyCount?.count ?? 0) >= 100) {
          throw new HttpError('KEY_LIMIT_REACHED', '每人最多保留 100 把有效 Key，请先吊销再创建');
        }
        const [row] = await tx
          .insert(apiKeys)
          .values({
            keyHash: sha256Hex(plaintext),
            keyPreview: maskKey(plaintext),
            userId: session.userId,
            name: body.name,
            remark: body.remark ?? null,
            subscriptionId,
            expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
            rpmLimit: body.rpmLimit ?? null,
            tpmLimit: body.tpmLimit ?? null,
            // numeric 列接受字符串；number → string 对齐 schema 类型
            dailySpendLimit: body.dailySpendLimit == null ? null : String(body.dailySpendLimit),
            status: 0,
          })
          .returning({ id: apiKeys.id, name: apiKeys.name, subscriptionId: apiKeys.subscriptionId });
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

    // 轮换：原子吊销旧 Key + 建新 Key，沿用旧 Key 的 name/限流/计费来源，明文只回显一次。
    .post('/:id/rotate', async (c) => {
      const session = c.get('session');
      const id = intParam(c, 'id');
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
        .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, session.userId), eq(apiKeys.status, 0)))
        .limit(1);
      if (!oldKey) throw new HttpError('API_KEY_NOT_FOUND', 'Key 不存在、无权操作或已吊销');

      // 轮换沿用计费来源，但必须重过创建面同款订阅归属校验（L1）：
      // 订阅已到期/被移出组织时盲目沿用会把新 Key 绑到不可用订阅上。
      // 校验不过 → 降级为个人余额 Key（订阅侧变化不应阻断轮换）。
      let subscriptionId = oldKey.subscriptionId;
      if (subscriptionId != null) {
        try {
          await assertCanUseSubscription(s.db, session.userId, subscriptionId);
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
            userId: session.userId,
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

      await recordAudit(s.db, {
        actor: 'user',
        action: 'api_key.rotate',
        targetType: 'api_key',
        targetId: created.id,
      });
      await invalidateKeyAuthCache(s.redis, [oldKey.keyHash]);
      return c.json({ ...created, key: plaintext }, 201);
    })

    // 更新（不可改 Key 本身 / 计费来源）
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
      if (!revoked) throw new HttpError('API_KEY_NOT_FOUND', 'Key 不存在、无权操作或已吊销');
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
