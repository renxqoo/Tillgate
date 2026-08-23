/**
 * 结算唤醒生产端（v1 billing/wakeup.ts 迁移；DESIGN C-G8）：
 * signal 成功转入 settlement_pending 后 `pg_notify('settle-wake', requestId)` 纯门铃
 * ——投递失败不重试不阻断（丢失由 worker 兜底扫描覆盖；消费端 LISTEN 归 worker 波）。
 * 通道名单一真相 = 本常量（db schema billing_requests 注释同源）。
 */
import { sql } from 'drizzle-orm';
import type { Db } from '@tokenlens/db';

export const SETTLE_WAKE_CHANNEL = 'settle-wake';

export interface SettleWake {
  wake(requestId: string): void;
  close(): Promise<void>;
}

export function createSettleWakeProducer(
  db: Db,
  logger?: { warn(obj: unknown, msg: string): void },
): SettleWake {
  return {
    wake(requestId: string) {
      // fire-and-forget：未 await（调用方在 billing signal 事务外同步路径上）
      void db
        .execute(sql`select pg_notify(${SETTLE_WAKE_CHANNEL}, ${requestId})`)
        .catch((error: unknown) => {
          logger?.warn({ err: String(error), requestId }, 'settle wake notify failed (worker scan covers)');
        });
    },
    async close() {
      // 无长连接资源（NOTIFY 经池化连接发出）；close 为 shutdown closeables 形状对齐
    },
  };
}
