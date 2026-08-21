/**
 * 结算唤醒消费端（PG LISTEN/NOTIFY）：settle_wake 通道通知到达即触发 runOnce；
 * 合并执行器把突发唤醒折叠成一次批次（正在跑时新唤醒只置 pending）。
 *
 * 连接模型：LISTEN 绑定单连接——专用 pg Client（不走池，池复用会丢 LISTEN
 * 状态）。通道故障语义：断线指数退避重连 + 重新 LISTEN；期间结算由定时
 * 兜底扫描继续（账务不依赖消息——认领/幂等全在 DB），断连记 error 级日志供告警。
 */
import { Client } from 'pg';
import { SETTLE_WAKE_CHANNEL } from '@ai-gateway/service';

export interface SettleWakeupConsumer {
  /** 合并执行器（供测试直接驱动） */
  coalescedRun(): Promise<void>;
  /** 首次 LISTEN 生效（生产端在此之前的 NOTIFY 会丢——由兜底扫描覆盖；测试用它消除竞态） */
  ready(): Promise<void>;
  close(): Promise<void>;
}

export function createCoalescedRunner(run: () => Promise<unknown>) {
  let running = false;
  let pending = false;
  return async function coalescedRun(): Promise<void> {
    if (running) {
      pending = true; // 正在跑：合并为跑完再来一轮
      return;
    }
    running = true;
    try {
      await run();
    } finally {
      running = false;
      if (pending) {
        pending = false;
        void coalescedRun();
      }
    }
  };
}

export function createSettleWakeupConsumer(
  databaseUrl: string,
  onWake: () => Promise<void>,
  options: {
    logger?: { error(obj: unknown, msg: string): void; info(obj: unknown, msg: string): void };
    /**
     * 满批阈值 + 排空回调：一次唤醒连续消费批次直到出现非满批（积压一次抽干，
     * 而非每个兜底周期只消化 batchSize 张）。缺省不排空（单批语义，测试友好）。
     */
    batchSize?: number;
    pendingCount?: () => Promise<number | null>;
  } = {},
): SettleWakeupConsumer {
  const coalescedRun = createCoalescedRunner(onWake);
  const drain = async (): Promise<void> => {
    // 满批连续排空：批次运行期间新通知被合并执行器吞——不排空的话这批新
    // pending 只能等 30s 兜底扫描，积压时吞吐塌到 0.67 张/秒
    for (let guard = 0; guard < 1_000; guard++) {
      const pending = await options.pendingCount?.();
      if (pending == null || pending === 0) break;
      await coalescedRun();
      if (pending < (options.batchSize ?? 1)) break;
    }
  };
  const onNotification = (): void => {
    if (options.pendingCount != null) {
      void drain();
    } else {
      void coalescedRun();
    }
  };

  let client: Client | null = null;
  let closed = false;
  let reconnectDelayMs = 1_000;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleReconnect = (err: Error): void => {
    if (closed) return;
    options.logger?.error(
      { err: err.message },
      'settle wake listener disconnected (sweep covers; reconnecting)',
    );
    client?.end().catch(() => undefined);
    client = null;
    if (reconnectTimer) return; // 已在退避等待
    const delay = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (closed) return;
      listen().catch(() => {
        /* 首连/重连失败：error 或 end 事件会再次接管调度 */
      });
    }, delay);
  };

  let markReady: (() => void) | null = null;
  const readyPromise = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const listen = async (): Promise<void> => {
    // application_name 身份标识：pg_stat_activity 可区分监听者（测试/排障按名精确操作，不误伤同库其他 LISTEN）
    const c = new Client({ connectionString: databaseUrl, application_name: 'settle-wake-listener' });
    client = c;
    c.on('notification', (msg) => {
      if (msg.channel === SETTLE_WAKE_CHANNEL) onNotification();
    });
    c.on('error', (err: Error) => scheduleReconnect(err));
    // 服务端断连（网络闪断/PG 重启）以 end 事件到达——同样走重连
    c.on('end', () => {
      if (!closed && client === c) scheduleReconnect(new Error('connection ended'));
    });
    await c.connect();
    // 通道名带连字符（settle-wake）：LISTEN 是标识符位，必须引号包裹（NOTIFY 走函数参数无此限制）
    await c.query(`listen "${SETTLE_WAKE_CHANNEL}"`);
    reconnectDelayMs = 1_000; // 连接健康：退避归位
    markReady?.(); // 首次与重连成功都幂等解锁 ready
  };

  listen().catch(() => {
    /* 首连失败由 error/end 事件驱动重连；ready 由重连成功的 listen() 尾部解锁 */
  });

  return {
    coalescedRun,
    ready: () => readyPromise,
    async close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      await client?.end().catch(() => undefined);
    },
  };
}
