/**
 * 订阅链路的账户侧协作 PostgreSQL adapter（users/orgs/api_keys/apps——跨能力事实直读实现）。
 * 生产可由 app assembly 桥接 accounts 能力替换（port 注入）。
 */
import { eq } from 'drizzle-orm';
import { apiKeys, apps, orgMembers, organizations, users, type Db, type DbTx } from '@tokenlens/db';
import type { AccountContextStore } from '../../ports/account-context.js';
import type { WalletConn } from '../../ports/wallet-store.js';

function tx(conn: WalletConn): DbTx {
  return conn as unknown as DbTx;
}

export function createAccountContextStore(_db: Db): AccountContextStore {
  return {
    async userExists(conn: WalletConn, userId: number) {
      const [row] = await tx(conn).select({ id: users.id }).from(users).where(eq(users.id, userId));
      return row != null;
    },
    async isEnterprise(conn: WalletConn, userId: number) {
      const [row] = await tx(conn)
        .select({ isEnterprise: users.isEnterprise })
        .from(users)
        .where(eq(users.id, userId));
      return row?.isEnterprise;
    },
    async insertOrgWithOwner(conn: WalletConn, input: { name: string; ownerUserId: number }) {
      const [org] = await tx(conn)
        .insert(organizations)
        .values({ name: input.name, ownerUserId: input.ownerUserId })
        .returning({ id: organizations.id });
      await tx(conn).insert(orgMembers).values({
        orgId: org!.id,
        userId: input.ownerUserId,
        role: 'owner',
        status: 0,
      });
      return org!.id;
    },
    async rebindCredentials(
      conn: WalletConn,
      fromSubscriptionId: number,
      toSubscriptionId: number,
    ) {
      await tx(conn)
        .update(apiKeys)
        .set({ subscriptionId: toSubscriptionId })
        .where(eq(apiKeys.subscriptionId, fromSubscriptionId));
      await tx(conn)
        .update(apps)
        .set({ subscriptionId: toSubscriptionId })
        .where(eq(apps.subscriptionId, fromSubscriptionId));
    },
  };
}
