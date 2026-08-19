/**
 * 用例层执行上下文（请求级）——三生命周期法则的 app 侧落点：
 *
 *   进程级（db/guards/clock/repos）→ 装配注入，工厂闭包捕获，不出现在调用链
 *   请求级（requestId/actor/traceParent）→ 本类型，用例第一个参数
 *   事务级（db=tx）→ 用例内 db.transaction 派生 RepoContext 传给仓储；
 *   跨用例组事务（如 billing 的 §4 补充授权）由调用方在 input.tx 注入共享事务
 *
 * ctx 准入红线：只放「描述这次执行是谁、哪条链路」的数据；
 * 业务参数是 command（显式第二参数），进程依赖是 env（装配注入）。
 */
import type { Db, DbTx } from '@ai-gateway/repository';
import type { Actor, RepoContext } from '@ai-gateway/repository';

export type { Actor };

/** 请求级上下文（不可变；构造于用例调用点——HTTP 中间件或任务入口） */
export type RunContext = Omit<RepoContext, 'db'>;

/** 事务内派生：repo 写方法只见 RepoContext（事务会话 + 元数据一体） */
export function inTx(ctx: RunContext, tx: DbTx): RepoContext {
  return { ...ctx, db: tx };
}

/** 只读派生：repo 读方法可直接跑在连接池上 */
export function readOnly(ctx: RunContext, db: Db): RepoContext {
  return { ...ctx, db };
}

/** 系统执行（定时任务/治理脚本/迁移）的最小上下文 */
export function systemContext(requestId: string): RunContext {
  return { requestId, actor: { kind: 'system' }, traceParent: null };
}
