/**
 * 结算唤醒生产端（PG NOTIFY）：signal 落 settlement_pending 后向 settle_wake
 * 通道投递通知——payload 携 requestId 仅供排障，不带账务指令。
 *
 * 语义：纯门铃——NOTIFY 失败只记日志（worker 定时兜底扫描覆盖，账务以
 * DB 认领/幂等为权威，消息可丢）。突发通知由消费端合并执行器折叠，
 * 不需要生产端去重（NOTIFY 无限投递，但它是 O(1) 内存队列，量级完全可承受）。
 */
import { SETTLE_WAKE_CHANNEL } from '@ai-gateway/service';

export interface SettleWakeupProducer {
  /** 注入 billing domain 的 wake 端口（fire-and-forget） */
  wake: (requestId: string) => void;
  close(): Promise<void>;
}

export function createSettleWakeupProducer(
  query: (sql: string, params: unknown[]) => Promise<unknown>,
  options: { logger?: { warn(obj: unknown, msg: string): void } } = {},
): SettleWakeupProducer {
  return {
    wake(requestId) {
      void query('select pg_notify($1, $2)', [SETTLE_WAKE_CHANNEL, requestId]).catch(
        (error: Error) => {
          options.logger?.warn(
            { err: error.message, requestId },
            'settle wake notify failed (worker sweep covers loss)',
          );
        },
      );
    },
    // 池连接归装配根管理，生产端无独占资源
    async close() {},
  };
}
