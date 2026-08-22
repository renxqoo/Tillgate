/**
 * 订阅链路的账户侧协作 port（总纲 §5.2 跨能力事实）：用户存在性/企业标记（users）、
 * 团队套餐组织创建（organizations）、凭证改绑（api_keys.subscription_id）。
 * 生产由 app assembly 桥接 accounts 能力或由本包 postgres adapter 直读实现；
 * billing 只消费这些事实，不拥有 accounts 语义。
 */
import type { WalletConn } from './wallet-store.js';

export interface AccountContextStore {
  userExists(conn: WalletConn, userId: number): Promise<boolean>;
  isEnterprise(conn: WalletConn, userId: number): Promise<boolean | undefined>;
  /** 团队套餐组织在购买事务内创建（与订阅共生死——预建会留孤儿 org） */
  insertOrgWithOwner(tx: WalletConn, input: { name: string; ownerUserId: number }): Promise<number>;
  /** 续费/变更后把绑定旧订阅的凭证改绑到新订阅（不打断现有 key/app） */
  rebindCredentials(
    tx: WalletConn,
    fromSubscriptionId: number,
    toSubscriptionId: number,
  ): Promise<void>;
}
