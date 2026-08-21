/**
 * 凭证仓储（api_keys + apps——静态 Key 与 App JWT 是凭证的两形态，同一聚合族）：
 * 授权来源解析（订阅绑定单一真相——授权管线不信任调用方传参）+ 凭证改绑。
 * users 侧读数走 UserRepository，本文件不碰 users 表。
 */
import { and, eq, or, sql } from 'drizzle-orm';
import type { DbTx } from '@ai-gateway/db';
import { apiKeys, apps, users } from '@ai-gateway/db';
import type { RepoContext } from './context.js';
import { UserRepository } from './user.repo.js';

function tx(c: RepoContext): DbTx {
  return c.db as DbTx;
}

export interface SourceResolution {
  subscriptionId: number | null;
  /** 包月额度耗尽自动转 PAYG（api_keys.allow_payg_fallback；App JWT 恒 false） */
  allowPaygFallback: boolean;
  userDailyLimit: string | null;
  keyDailyLimit: string | null;
}

/** 凭证仓储（无状态；方法统一接收 RepoContext——事务由用例层注入） */
export class CredentialRepository {
  /** 凭证 → 订阅绑定 + 用户/Key 每日限额（一次解析，授权管线消费） */
  async resolveSourceAndLimits(
    c: RepoContext,
    input: { userId: number; apiKeyId: number | null; appId: number | null },
  ): Promise<SourceResolution> {
    const userDailyLimit = await new UserRepository().findDailySpendLimit(c, input.userId);
    let subscriptionId: number | null = null;
    let keyDailyLimit: string | null = null;
    let allowPaygFallback = false;
    if (input.apiKeyId != null) {
      const [key] = await c.db
        .select({
          subscriptionId: apiKeys.subscriptionId,
          dailySpendLimit: apiKeys.dailySpendLimit,
          allowPaygFallback: apiKeys.allowPaygFallback,
        })
        .from(apiKeys)
        .where(eq(apiKeys.id, input.apiKeyId));
      if (key) {
        subscriptionId = key.subscriptionId ?? null;
        keyDailyLimit = key.dailySpendLimit ?? null;
        allowPaygFallback = key.allowPaygFallback;
      }
    } else if (input.appId != null) {
      const [app] = await c.db
        .select({ subscriptionId: apps.subscriptionId })
        .from(apps)
        .where(eq(apps.id, input.appId));
      if (app) subscriptionId = app.subscriptionId ?? null;
    }
    return { subscriptionId, allowPaygFallback, userDailyLimit, keyDailyLimit };
  }

  /** 按 appId 查有效 App 凭证（JWT 鉴权路径：app status=0 且属主正常；
   *  带属主用户级限流——JWT 无凭证级限额时的执行口径） */
  async findActiveAppById(
    c: RepoContext,
    appId: number,
  ): Promise<{
    id: number;
    userId: number;
    subscriptionId: number | null;
    userRpmLimit: number | null;
    userTpmLimit: number | null;
  } | null> {
    const [row] = await c.db
      .select({
        id: apps.id,
        userId: apps.userId,
        subscriptionId: apps.subscriptionId,
        userRpmLimit: users.rpmLimit,
        userTpmLimit: users.tpmLimit,
      })
      .from(apps)
      .innerJoin(users, eq(users.id, apps.userId))
      .where(and(eq(apps.id, appId), eq(apps.status, 0), eq(users.status, 0)));
    if (!row) return null;
    return {
      id: row.id,
      userId: row.userId,
      subscriptionId: row.subscriptionId ?? null,
      userRpmLimit: row.userRpmLimit,
      userTpmLimit: row.userTpmLimit,
    };
  }

  /** 按哈希查有效静态 Key（鉴权路径：status=0 且未过期且属主用户正常；返回鉴权与来源解析所需全集）
   *  属主 join 不可省：封禁用户（users.status≠0）的存量 Key 必须立即失效——
   *  否则封禁只挡控制台登录，网关推理照常放行。
   *  带用户级限流（users.rpm/tpm_limit——Key 级限额缺省时的执行口径） */
  async findActiveKeyByKeyHash(
    c: RepoContext,
    keyHash: string,
  ): Promise<{
    id: number;
    userId: number;
    appId: number | null;
    subscriptionId: number | null;
    dailySpendLimit: string | null;
    allowPaygFallback: boolean;
    /** Key 级限流（null/0 = 不限） */
    rpmLimit: number | null;
    tpmLimit: number | null;
    /** 属主用户级限流（Key 级缺省时生效） */
    userRpmLimit: number | null;
    userTpmLimit: number | null;
  } | null> {
    const [key] = await c.db
      .select({
        id: apiKeys.id,
        userId: apiKeys.userId,
        appId: apiKeys.appId,
        subscriptionId: apiKeys.subscriptionId,
        dailySpendLimit: apiKeys.dailySpendLimit,
        allowPaygFallback: apiKeys.allowPaygFallback,
        rpmLimit: apiKeys.rpmLimit,
        tpmLimit: apiKeys.tpmLimit,
        userRpmLimit: users.rpmLimit,
        userTpmLimit: users.tpmLimit,
      })
      .from(apiKeys)
      .innerJoin(users, eq(users.id, apiKeys.userId))
      .where(
        and(
          eq(apiKeys.keyHash, keyHash),
          eq(apiKeys.status, 0),
          eq(users.status, 0),
          or(sql`${apiKeys.expiresAt} is null`, sql`${apiKeys.expiresAt} > clock_timestamp()`),
        ),
      );
    return key ?? null;
  }

  /** 凭证改绑（续费/升档：付了钱后既有 Key/App 不应全员 402） */
  async rebindCredentials(
    c: RepoContext,
    oldSubscriptionId: number,
    newSubscriptionId: number,
  ): Promise<void> {
    await tx(c)
      .update(apiKeys)
      .set({ subscriptionId: newSubscriptionId })
      .where(eq(apiKeys.subscriptionId, oldSubscriptionId));
    await tx(c)
      .update(apps)
      .set({ subscriptionId: newSubscriptionId })
      .where(eq(apps.subscriptionId, oldSubscriptionId));
  }
}
