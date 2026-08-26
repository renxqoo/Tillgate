/**
 * 会话级 advisory try-lock(Bun SQL 专用连接):分区维护/对账哨兵等跨进程互斥用。
 *
 * 与 transaction.ts 的 advisoryLock(xact 锁)互补:本锁不依赖事务,由调用方
 * 显式解锁,持有期横跨多条独立语句——锁连接是 reserve 出的专用连接,不与
 * 池内事务争用;未获锁返回 null(调用方跳过本轮,另一副本在跑)。
 */
import type { Db } from './client.js';

export async function withSessionTryLock<T>(
  db: Db,
  key: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const client = await db.$client.reserve();
  try {
    const locked = await client.unsafe<Array<{ locked: boolean }>>(
      'select pg_try_advisory_lock(hashtext($1)) as locked',
      [key],
    );
    if (locked[0]?.locked !== true) return null;
    try {
      return await fn();
    } finally {
      await client.unsafe('select pg_advisory_unlock(hashtext($1))', [key]);
    }
  } finally {
    await client.release();
  }
}
