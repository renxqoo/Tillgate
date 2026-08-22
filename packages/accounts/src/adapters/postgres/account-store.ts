/**
 * Postgres AccountStore 适配器:按聚合分节(users/keys/apps/orgs/referrals)
 * 组装为单一端口实现;本文件只做组装,SQL 在各分节(§0.5 一聚合一文件)。
 *
 * 语义契约(与 testing 内存替身同拍演进,DESIGN §5):
 * - 时间单一来源 = clock_timestamp()(写入/过期判定;B4/B6 修复);
 * - 状态翻转 CAS 单语句,0 行 → null/false;
 * - 投影结构性排除秘密列(keyHash/clientSecretHash/passwordHash);
 * - ilike 走转义;排序附 desc(id) 稳定 tiebreaker;
 * - 唯一冲突翻译只在 insertLocalUser(email_taken);其余 23505 原样上抛,
 *   由 app face 的 PG 边界翻译族处理(ADR-0002)。
 * - user_subscriptions 只读最小投影 {id, quantity}(G8:席位事实归 billing,
 *   FOR UPDATE 与 billing 侧数量变更同锁互斥)。
 */
import type { AccountStorePort } from '../../ports/account-store.js';
import { userQueries } from './users.js';
import { keyQueries } from './keys.js';
import { appQueries } from './apps.js';
import { orgQueries } from './orgs.js';
import { referralQueries } from './referrals.js';

export function createPostgresAccountStore(): AccountStorePort {
  return {
    ...userQueries,
    ...keyQueries,
    ...appQueries,
    ...orgQueries,
    ...referralQueries,
  };
}
