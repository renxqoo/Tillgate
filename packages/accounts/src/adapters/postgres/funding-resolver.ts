/**
 * billing FundingSourceResolver 的 postgres 实现（gateway P5 波 C-G4；billing
 * IMPLEMENTATION §8-2 明示「resolver 桥接在 app assembly 完成」，本件是其 SQL 面
 * ——凭证事实归 accounts，装配方 apps/gateway 从 ./composition 取件，SQL 不进 app）。
 *
 * 结构等价而非类型导入：accounts 不依赖 billing（§5.2 无此边）——resolve 的 conn
 * 参数以 billing WalletConn 的结构形状（brand 标记对象）承接，事务句柄实际是
 * billing 侧 DbTx（billing wallet-store 的 asDb 同款解释）。
 *
 * 语义 = v1 credential.repo resolveSourceAndLimits：
 *   userDailyLimit ← users.daily_spend_limit；
 *   apiKeyId 优先 → api_keys {subscription_id, daily_spend_limit, allow_payg_fallback}；
 *   否则 appId → apps {subscription_id}（App-JWT 恒 allowPaygFallback=false）。
 */
import { eq } from 'drizzle-orm';
import type { DbTx } from '@tokenlens/db';
import { apiKeys, apps, users } from '@tokenlens/db';

/** billing WalletConn 的结构形状（brand-only；实际句柄为 billing 事务的 DbTx） */
interface BillingConn {
  readonly connBrand: 'wallet-conn';
}

export interface ResolvedFunding {
  subscriptionId: number | null;
  allowPaygFallback: boolean;
  userDailyLimit: string | null;
  keyDailyLimit: string | null;
}

export interface PgFundingSourceResolver {
  resolve(
    conn: BillingConn,
    input: { userId: number; apiKeyId: number | null; appId: number | null },
  ): Promise<ResolvedFunding>;
}

export function createPgFundingSourceResolver(): PgFundingSourceResolver {
  return {
    async resolve(conn, input) {
      const db = conn as unknown as DbTx;
      const [user] = await db
        .select({ dailySpendLimit: users.dailySpendLimit })
        .from(users)
        .where(eq(users.id, input.userId));
      const userDailyLimit = user?.dailySpendLimit ?? null;

      if (input.apiKeyId != null) {
        const [key] = await db
          .select({
            subscriptionId: apiKeys.subscriptionId,
            dailySpendLimit: apiKeys.dailySpendLimit,
            allowPaygFallback: apiKeys.allowPaygFallback,
          })
          .from(apiKeys)
          .where(eq(apiKeys.id, input.apiKeyId));
        if (key) {
          return {
            subscriptionId: key.subscriptionId ?? null,
            allowPaygFallback: key.allowPaygFallback,
            userDailyLimit,
            keyDailyLimit: key.dailySpendLimit ?? null,
          };
        }
      } else if (input.appId != null) {
        const [app] = await db
          .select({ subscriptionId: apps.subscriptionId })
          .from(apps)
          .where(eq(apps.id, input.appId));
        if (app) {
          return {
            subscriptionId: app.subscriptionId ?? null,
            allowPaygFallback: false,
            userDailyLimit,
            keyDailyLimit: null,
          };
        }
      }
      return { subscriptionId: null, allowPaygFallback: false, userDailyLimit, keyDailyLimit: null };
    },
  };
}
