/**
 * @ai-gateway/repository —— 数据访问层（唯一允许出现 SQL 的包）。
 *
 * 分层契约（四层铁律，边界测试强制）：
 *   services（app 侧）→ domain（app 侧，纯逻辑）→ 本包（全部 SQL）→ packages/db（表）
 *
 *   - 方法 = 意图化原子操作（tryReserveQuota / claimPending / finalizeSettled…），
 *     禁止退化成 CRUD：守卫 UPDATE / SKIP LOCKED / CAS 的原子性是方法边界；
 *   - 方法统一接收 RepoContext（db 会话 + 执行元数据）——写路径 db 必须是事务句柄
 *     （事务由 app 的用例层持有并注入），只读路径可以是连接池句柄；
 *   - 返回中性结果（行形状 / 语义枚举），不认识 app 的错误家谱——翻译在上层；
 *   - 本包只依赖 packages/db 与 drizzle-orm，不 import 任何 app。
 */
import type { Db, DbTx } from '@ai-gateway/db';

/** db 会话：事务句柄（写路径，用例层注入）或连接池句柄（只读路径） */
export type DbLike = Db | DbTx;

/**
 * 操作发起者（审计归属的唯一来源——幂等指纹/审计行统一从此取，替代散落参数）。
 */
export type Actor =
  | { kind: 'user'; id: number }
  | { kind: 'admin'; id: number }
  | { kind: 'system' };

/**
 * 仓储执行上下文：db 会话 + 请求级元数据（谁、哪条链路）。
 * 不可变值对象；app 侧用例从自己的 RunContext 派生。
 */
export interface RepoContext {
  readonly db: DbLike;
  /** 链路锚：审计/日志/幂等关联 */
  readonly requestId: string;
  readonly actor: Actor;
  readonly traceParent: string | null;
}
