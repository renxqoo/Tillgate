/**
 * 会话失效 port(§3.4 唯一所有者 = identity):email 变更等身份事实变更时推进
 * identity 会话吊销线(全网下线)。事务参与形态——db 首参传调用方业务事务的 tx,
 * 随事务原子(回滚即未失效);accounts 不直接依赖 identity(§5.2 消费方 port,
 * 生产 bridge 由 app assembly 连接 identity anchor advance,同 notifications outbox 先例)。
 */
import type { DbLike } from '@tokenlens/db';

/** accounts 管理的是用户面账号;realm 词表归 identity,'user' 为稳定词表项 */
export const SESSION_REALM = 'user';

export interface SessionInvalidationPort {
  /** 在调用方事务内推进吊销线;失败抛错随业务事务回滚 */
  invalidateUserSessions(db: DbLike, input: { realm: string; userId: number }): Promise<void>;
}
