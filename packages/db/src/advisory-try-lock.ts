/**
 * 会话级 advisory try-lock(Bun SQL 专用连接):分区维护/对账哨兵等跨进程互斥用。
 *
 * 与 transaction.ts 的 advisoryLock(xact 锁)互补:本锁不依赖事务,由调用方
 * 显式解锁,持有期横跨多条独立语句——锁连接是 reserve 出的专用连接,不与
 * 池内事务争用;未获锁返回 null(调用方跳过本轮,另一副本在跑)。
 *
 * 解锁失败(红队复审 R-5):会话锁随连接存续——若把解锁失败的连接 release
 * 归还池,锁悬挂至 idleTimeout 收割,期间该连接被复用后同键 try-lock 会
 * 误命中。处置 = 销毁该连接(锁随连接死亡释放),可选 onDefect 钩子上报。
 */
import type { Db } from './client.js';

/** 解锁失败的缺陷上报(db 包不持日志依赖——装配层注入;缺省仅销毁) */
export type LockDefectHook = (error: unknown, key: string) => void;

export interface SessionTryLockInput {
  /** 锁键(hashtext → advisory key) */
  key: string;
  /** 解锁失败缺陷上报(可选——连接已销毁,钩子只做可观测) */
  onDefect?: LockDefectHook;
}

export async function withSessionTryLock<T>(
  db: Db,
  input: SessionTryLockInput,
  fn: () => Promise<T>,
): Promise<T | null> {
  const { key, onDefect } = input;
  const client = await db.$client.reserve();
  let unlockFailed = false;
  try {
    const locked = await client.unsafe<Array<{ locked: boolean }>>(
      'select pg_try_advisory_lock(hashtext($1)) as locked',
      [key],
    );
    if (locked[0]?.locked !== true) return null;
    try {
      return await fn();
    } finally {
      try {
        await client.unsafe('select pg_advisory_unlock(hashtext($1))', [key]);
      } catch (error) {
        unlockFailed = true;
        onDefect?.(error, key);
      }
    }
  } finally {
    if (unlockFailed) {
      // close() 销毁单条保留连接(Bun SQL 未文档化 API,升级需真 PG 回归:
      // 断言 advisory 锁随连接销毁释放)。close 再失败只能吞——死连接由池收割
      await client.close().catch(() => {});
    } else {
      await client.release();
    }
  }
}
