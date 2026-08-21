/**
 * API Key 管理服务：创建（明文仅此一次出库）/ 列表（永不回 keyHash）/ 吊销（属主 + CAS）。
 * 配额闸：单用户在用 Key 上限（装配注入）。明文格式与鉴权查表口径来自 @ai-gateway/http
 * （ag_ 前缀 + SHA-256 落库——与网关 findActiveKeyByKeyHash 同一真相）。
 */
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type Repositories, type ApiKeyRow } from '@ai-gateway/repository';
import { generateApiKey, maskKey, sha256Hex } from '@ai-gateway/http';
import type { RunContext } from '@ai-gateway/service';
import { AppError } from '../http/error-map.js';
import { recordAudit } from '@ai-gateway/http';

export interface KeysServiceDeps {
  db: Db;
  repos?: Repositories;
  /** 在用 Key 数量上限 */
  clock?: () => Date;
}

export interface CreateKeyInput {
  name: string;
  remark?: string | null;
  rpmLimit?: number | null;
  tpmLimit?: number | null;
  dailySpendLimit?: string | null;
  /** ISO 时间串（zod 已校验未来时点） */
  expiresAt?: string | null;
  /** 计费来源：绑定订阅（null=余额）。归属守卫：owner 本人或组织 active 成员 */
  subscriptionId?: number | null;
}

export interface KeysService {
  create(
    ctx: RunContext,
    userId: number,
    input: CreateKeyInput,
  ): Promise<ApiKeyRow & { plaintext: string }>;
  list(
    ctx: RunContext,
    userId: number,
    input: { page: number; limit: number },
  ): Promise<{ rows: ApiKeyRow[]; total: number }>;
  revoke(ctx: RunContext, userId: number, keyId: number): Promise<{ id: number }>;
  patch(
    ctx: RunContext,
    userId: number,
    keyId: number,
    patch: {
      name?: string;
      remark?: string | null;
      rpmLimit?: number | null;
      tpmLimit?: number | null;
      dailySpendLimit?: string | null;
      expiresAt?: Date | null;
    },
  ): Promise<ApiKeyRow>;
  /**
   * 轮换：旧 Key 吊销 + 新 Key 继承设置；计费来源重新校验——订阅已过期/失格则
   * 降级为个人余额（subscriptionId=null）。明文仅此一次返回。
   */
  rotate(
    ctx: RunContext,
    userId: number,
    keyId: number,
  ): Promise<{ revokedId: number } & ApiKeyRow & { plaintext: string }>;
}

const asUser = (ctx: RunContext, userId: number): RunContext => ({
  ...ctx,
  actor: { kind: 'user', id: userId },
});

export function createKeysService(deps: KeysServiceDeps): KeysService {
  const { db } = deps;
  const repos = deps.repos ?? createRepositories();
  const clock = deps.clock ?? (() => new Date());

  return {
    async create(ctx, userId, input) {
      const runCtx = asUser(ctx, userId);
      // 计费来源归属守卫：绑他人订阅 → 404（不泄漏存在性；与授权侧防御互为纵深）
      let subscriptionId = input.subscriptionId ?? null;
      if (subscriptionId != null) {
        const usable = await repos.org.findUsableSubscription(
          { db, ...runCtx },
          { userId, subscriptionId, now: clock() },
        );
        if (!usable) {
          throw new AppError(404, 'subscription_not_usable', 'Subscription not found, expired, or not usable');
        }
      }
      const plaintext = generateApiKey();
      const row = await db.transaction(async (tx) => {
        return repos.apiKey.insertKey({ db: tx, ...runCtx }, {
          keyHash: sha256Hex(plaintext),
          keyPreview: maskKey(plaintext),
          userId,
          name: input.name,
          remark: input.remark ?? null,
          rpmLimit: input.rpmLimit ?? null,
          tpmLimit: input.tpmLimit ?? null,
          dailySpendLimit: input.dailySpendLimit ?? null,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          subscriptionId,
        });
      });
      // 用户面审计：凭证操作可追溯
      await recordAudit(deps.db, {
        actor: 'user',
        action: 'key.create',
        targetType: 'api_key',
        targetId: row.id,
        detail: { name: input.name, subscriptionId },
      }).catch(() => undefined);
      // 明文唯一一次出库：此后只存哈希 + 末4位预览
      return { ...row, plaintext };
    },

    async list(ctx, userId, input) {
      const runCtx = asUser(ctx, userId);
      return repos.apiKey.listByUser({ db, ...runCtx }, {
        userId,
        limit: input.limit,
        offset: (input.page - 1) * input.limit,
      });
    },

    async revoke(ctx, userId, keyId) {
      const runCtx = asUser(ctx, userId);
      const owned = await repos.apiKey.findOwned({ db, ...runCtx }, { userId, keyId });
      // 不存在与越权同响应（不泄漏他人 Key 的存在性）
      if (!owned) throw new AppError(404, 'key_not_found', 'API key not found');
      if (owned.status !== 0) throw new AppError(409, 'key_already_revoked', 'API key already revoked');
      const revoked = await db.transaction(async (tx) =>
        repos.apiKey.revokeKey({ db: tx, ...runCtx }, { userId, keyId, now: clock() }),
      );
      if (!revoked) throw new AppError(409, 'key_already_revoked', 'API key already revoked');
      await recordAudit(deps.db, {
        actor: 'user',
        action: 'key.revoke',
        targetType: 'api_key',
        targetId: keyId,
      }).catch(() => undefined);
      return { id: keyId };
    },

    async patch(ctx, userId, keyId, patch) {
      const runCtx = asUser(ctx, userId);
      const owned = await repos.apiKey.findOwned({ db, ...runCtx }, { userId, keyId });
      if (!owned) throw new AppError(404, 'key_not_found', 'API key not found');
      if (owned.status !== 0) throw new AppError(409, 'key_already_revoked', 'API key already revoked');
      const updated = await db.transaction(async (tx) =>
        repos.apiKey.patchKey({ db: tx, ...runCtx }, { userId, keyId, patch }),
      );
      if (!updated) throw new AppError(409, 'key_already_revoked', 'API key already revoked');
      // 回显脱敏：行形状从不含 keyHash（只 keyPreview）
      return updated;
    },

    async rotate(ctx, userId, keyId) {
      const runCtx = asUser(ctx, userId);
      const owned = await repos.apiKey.findOwned({ db, ...runCtx }, { userId, keyId });
      if (!owned) throw new AppError(404, 'key_not_found', 'API key not found');
      if (owned.status !== 0) throw new AppError(409, 'key_already_revoked', 'API key already revoked');

      // 计费来源重新校验：过期/失格 → 新 Key 降级为个人余额
      let subscriptionId = owned.subscriptionId;
      if (subscriptionId != null) {
        const usable = await repos.org.findUsableSubscription(
          { db, ...runCtx },
          { userId, subscriptionId, now: clock() },
        );
        if (!usable) subscriptionId = null;
      }

      const plaintext = generateApiKey();
      const created = await db.transaction(async (tx) => {
        const c = { db: tx, ...runCtx };
        // 新 Key 继承设置（过期时间原样沿用旧 Key）；quota 闸按「替换」口径不计增量
        const inserted = await repos.apiKey.insertKey(c, {
          keyHash: sha256Hex(plaintext),
          keyPreview: maskKey(plaintext),
          userId,
          name: owned.name,
          remark: owned.remark,
          rpmLimit: owned.rpmLimit,
          tpmLimit: owned.tpmLimit,
          dailySpendLimit: owned.dailySpendLimit,
          expiresAt: owned.expiresAt,
          subscriptionId,
        });
        const revoked = await repos.apiKey.revokeKey(c, { userId, keyId, now: clock() });
        if (!revoked) throw new AppError(409, 'key_already_revoked', 'API key already revoked');
        return inserted;
      });
      await recordAudit(deps.db, {
        actor: 'user',
        action: 'key.rotate',
        targetType: 'api_key',
        targetId: created.id,
        detail: { revokedId: keyId },
      }).catch(() => undefined);
      return { revokedId: keyId, ...created, plaintext };
    },
  };
}
