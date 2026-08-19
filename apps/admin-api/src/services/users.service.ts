/**
 * 用户管理服务：列表（钱包富化）/ 资料 / 补丁（封禁语义 + 换卡守卫 +
 * 邮箱变更推进失效线 + 网关鉴权缓存清除）/ 重置密码（本地账号守卫 +
 * 默认卡「标准」绑定 + 全网会话下线）/ 流水（wallet statement）/
 * 用户维度审计。
 * 列表列白名单永不包含 passwordHash——凭证数据不出库（泄漏红线）。
 */
import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { recordAudit } from '@ai-gateway/http';
import { hashPassword } from '@ai-gateway/identity-core';
import { advanceAnchor } from '@ai-gateway/identity';
import type { Db } from '@ai-gateway/repository';
import {
  createRepositories,
  type Repositories,
  type AdminUserRow,
  type AdminUserPatch,
} from '@ai-gateway/repository';
import type { RunContext, WalletApi } from '@ai-gateway/service';
import { Decimal } from '@ai-gateway/domain';
import { AppError } from '../http/error-map.js';
import type { ListQueryParts } from '../http/list-query.js';

export const USER_SORTS = ['id', 'subject', 'createdAt', 'lastLoginAt'] as const;
export const USER_AUDIT_SORTS = ['id', 'action', 'createdAt'] as const;
export const DEFAULT_RATE_CARD_NAME = '标准';

export interface UsersServiceDeps {
  db: Db;
  repos?: Repositories;
  wallet: Pick<WalletApi, 'accounts' | 'statement' | 'setCreditLimit'>;
  redis: Redis | null;
}

export interface UsersService {
  list(
    ctx: RunContext,
    input: { query: ListQueryParts; status?: number; enterprise?: '0' | '1' },
  ): Promise<{
    rows: Array<
      AdminUserRow & {
        balance: string;
        reservedBalance: string;
        creditLimit: string;
        availableBalance: string;
      }
    >;
    total: number;
    page: number;
    pageSize: number;
  }>;
  profile(ctx: RunContext, userId: number): Promise<AdminUserRow>;
  patch(
    ctx: RunContext,
    input: {
      adminId: number;
      userId: number;
      patch: AdminUserPatch & { creditLimit?: string };
    },
  ): Promise<{ id: number }>;
  setPassword(
    ctx: RunContext,
    input: { adminId: number; userId: number; password: string },
  ): Promise<{ ok: true }>;
  transactions(
    ctx: RunContext,
    input: { userId: number; limit: number },
  ): Promise<Array<{
    id: number;
    userId: number;
    type: string;
    amount: string;
    balanceAfter: string;
    refType: string;
    refId: string;
    remark: string | null;
    createdAt: Date;
  }>>;
  auditLogs(
    ctx: RunContext,
    input: { userId: number; query: ListQueryParts },
  ): Promise<{ rows: Array<{ id: number; actor: string; action: string; detail: unknown; createdAt: Date }>; total: number; page: number; pageSize: number }>;
}

export function createUsersService(deps: UsersServiceDeps): UsersService {
  const { db, wallet } = deps;
  const repos = deps.repos ?? createRepositories();

  /** 钱包富化（余额/在途/授信/可用；N+1 每行——wallet 是资金单一真相） */
  async function enrich(userId: number): Promise<{
    balance: string;
    reservedBalance: string;
    creditLimit: string;
    availableBalance: string;
  }> {
    const accounts = await wallet.accounts(
      { requestId: `enrich-${userId}`, actor: { kind: 'admin', id: 0 }, traceParent: null },
      userId,
    );
    const first = accounts[0];
    if (!first) {
      return { balance: '0', reservedBalance: '0', creditLimit: '0', availableBalance: '0' };
    }
    const balance = new Decimal(first.balance);
    const inFlight = new Decimal(first.inFlight);
    const creditLimit = new Decimal(first.creditLimit);
    return {
      balance: first.balance,
      reservedBalance: first.inFlight,
      creditLimit: first.creditLimit,
      availableBalance: balance.plus(creditLimit).minus(inFlight).toString(),
    };
  }

  return {
    async list(ctx, input) {
      const result = await repos.user.listAdminUsers({ db, ...ctx }, {
        q: input.query.q,
        status: input.status,
        enterprise: input.enterprise,
        sortBy: input.query.sortBy as (typeof USER_SORTS)[number],
        order: input.query.order,
        limit: input.query.limit,
        offset: input.query.offset,
      });
      const rows = await Promise.all(
        result.rows.map(async (row) => ({ ...row, ...(await enrich(row.id)) })),
      );
      return { rows, total: result.total, page: input.query.page, pageSize: input.query.pageSize };
    },

    async profile(ctx, userId) {
      const user = await repos.user.findAdminUser({ db, ...ctx }, userId);
      if (!user) throw new AppError(404, 'user_not_found', '用户不存在');
      return { ...user, rateCardName: null };
    },

    async patch(ctx, input) {
      const user = await repos.user.findAdminUser({ db, ...ctx }, input.userId);
      if (!user) throw new AppError(404, 'user_not_found', '用户不存在');

      const { creditLimit, ...patch } = input.patch;
      // 换卡守卫：卡存在且启用
      if (patch.rateCardId != null) {
        const card = await repos.rateCard.findById({ db, ...ctx }, patch.rateCardId);
        if (!card) throw new AppError(404, 'rate_card_not_found', '费率卡不存在');
        if (card.status !== 0) throw new AppError(400, 'rate_card_disabled', '费率卡已停用');
      }
      // 封禁语义：封禁带原因（缺省「管理员封禁」）；解封清原因
      if (patch.status === 1) patch.freezeReason = patch.freezeReason ?? '管理员封禁';
      if (patch.status === 0) patch.freezeReason = null;

      // 邮箱变更 = 身份事实变更：同事务推进失效线（全网会话下线）
      if (patch.email !== undefined) {
        await db.transaction(async (tx) => {
          await advanceAnchor(tx, 'user', input.userId, new Date());
          await repos.user.patchUser({ db: tx, ...ctx }, { userId: input.userId, patch });
        });
      } else {
        await repos.user.patchUser({ db, ...ctx }, { userId: input.userId, patch });
      }

      // 授信地板走 wallet（审计交易 + 回执）；PATCH 非幂等——refId 唯一
      if (creditLimit !== undefined) {
        await wallet.setCreditLimit(ctx, {
          userId: input.userId,
          amount: creditLimit,
          refType: 'admin',
          refId: `admin-credit-line-${input.userId}-${Date.now()}-${randomBytes(3).toString('hex')}`,
        });
      }

      // 状态/限额变更即时生效：清网关鉴权缓存（不等 60s TTL）
      if (
        patch.status !== undefined ||
        patch.rpmLimit !== undefined ||
        patch.tpmLimit !== undefined ||
        patch.dailySpendLimit !== undefined
      ) {

      }

      await recordAudit(db, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'user.update',
        targetType: 'user',
        targetId: input.userId,
        detail: { ...input.patch },
      });
      return { id: input.userId };
    },

    async setPassword(ctx, input) {
      const user = await repos.user.findAdminUser({ db, ...ctx }, input.userId);
      if (!user) throw new AppError(404, 'user_not_found', '用户不存在');
      // 只能为本地账号设密：给 OIDC 身份挂本地密码 = 管理员接管
      if (user.issuer !== 'local') {
        throw new AppError(400, 'not_local_account', '只能为本地账号（issuer=local）设置密码');
      }
      const passwordHash = await hashPassword(input.password);

      await db.transaction(async (tx) => {
        // 未绑卡 → 绑默认卡「标准」；缺全局兜底系数则回填 1.000（并发安全）
        if (user.rateCardId == null) {
          const standard = await repos.rateCard.findByName({ db: tx, ...ctx }, DEFAULT_RATE_CARD_NAME);
          if (standard) {
            await repos.rateCard.ensureGlobalCoefficient({ db: tx, ...ctx }, standard.id);
            await repos.user.patchUser({ db: tx, ...ctx }, {
              userId: input.userId,
              patch: { rateCardId: standard.id },
            });
          }
        }
        // 改密 + 失效线同拍：全网旧会话即刻下线（R5-2）
        await repos.userAccount.updatePassword({ db: tx, ...ctx }, {
          userId: input.userId,
          passwordHash,
          invalidBefore: new Date(),
        });
      });

      await recordAudit(db, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'user.set_password',
        targetType: 'user',
        targetId: input.userId,
      });
      return { ok: true as const };
    },

    async transactions(ctx, input) {
      const exists = await repos.user.userExists({ db, ...ctx }, input.userId);
      if (!exists) throw new AppError(404, 'user_not_found', '用户不存在');
      // wallet statement：newest-first + 余额链不变量（资金单一真相）
      const items = await wallet.statement(ctx, { userId: input.userId, limit: input.limit });
      return items.map((item) => ({
        id: item.legId,
        userId: input.userId,
        type: item.transactionKind,
        amount: item.amount,
        balanceAfter: item.balanceAfter,
        refType: item.refType,
        refId: item.refId,
        remark: item.memo,
        createdAt: item.createdAt,
      }));
    },

    async auditLogs(ctx, input) {
      const exists = await repos.user.userExists({ db, ...ctx }, input.userId);
      if (!exists) throw new AppError(404, 'user_not_found', '用户不存在');
      const result = await repos.user.listAuditLogsForUser({ db, ...ctx }, {
        userId: input.userId,
        q: input.query.q,
        sortBy: input.query.sortBy as (typeof USER_AUDIT_SORTS)[number],
        order: input.query.order,
        limit: input.query.limit,
        offset: input.query.offset,
      });
      return {
        rows: result.rows,
        total: result.total,
        page: input.query.page,
        pageSize: input.query.pageSize,
      };
    },
  };
}
