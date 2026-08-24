/**
 * 结算唤醒消费端（v1 wakeup.ts 的 PG LISTEN/NOTIFY 形态——BullMQ 移除）：
 *   - 专用连接（db.$client.connect()，不进池循环）LISTEN settle-wake；
 *   - coalescing（v1 createCoalescedRunner 纯闭包平移）：N 次并发唤醒 ≤ 2 次
 *     实际执行（一轮在跑 + 一轮 pending 补跑）；
 *   - drain（满批排空）：一轮认领满批（== batchSize）立即再跑，直到非满批或
 *     guard 上界——积压一次抽干。以认领计数为排空依据（v1 用 inventory
 *     pending 计数；claim 返回 0 = 无积压、< batchSize = 接近排空，等价且
 *     不新增 billing 读动词）；
 *   - 断线重连：连接 error/end → 指数退避重连（重发 LISTEN）。通道故障期间
 *     结算由兜底扫描继续——账务不依赖消息（认领/幂等全在 DB）。
 * 通知载荷（requestId）不解析——纯门铃，仅日志用途。
 */

/** LISTEN 专用连接的最小结构面（pg PoolClient 子集；测试注入假连接） */
export interface ListenConnection {
  query(text: string): Promise<unknown>;
  on(
    event: 'notification',
    listener: (payload: { channel?: string; payload?: string }) => void,
  ): void;
  on(event: 'error', listener: (error: Error) => void): void;
  release(): void;
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

export interface SettleWakeListener {
  /** 合并执行器（供测试直接驱动） */
  coalescedRun(): Promise<void>;
  close(): Promise<void>;
}

interface SettleWakeListenerEnv {
  connect: () => Promise<ListenConnection>;
  channel: string;
  /** 一轮结算批次（返回本轮认领数——满批即继续排空） */
  runBatch: () => Promise<number>;
  batchSize: number;
  logger: { warn(obj: unknown, msg: string): void; error(obj: unknown, msg: string): void };
  /** 重连退避（缺省 1s 起、×2、封顶 30s） */
  backoff?: { baseMs: number; maxMs: number };
  /** drain 轮数上界（防死循环；缺省 1000——v1 guard 同值） */
  drainGuard?: number;
}

const DRAIN_GUARD_DEFAULT = 1_000;

// eslint-disable-next-line max-lines-per-function -- LISTEN 唤醒监听闭包工厂:listen/scheduleReconnect/close 共享 closed/connection/attempt 重连状态,拆分即互相回读(存量棘轮)
export function createSettleWakeListener(env: SettleWakeListenerEnv): SettleWakeListener {
  const backoff = env.backoff ?? { baseMs: 1_000, maxMs: 30_000 };
  const guard = env.drainGuard ?? DRAIN_GUARD_DEFAULT;

  let closed = false;
  let connection: ListenConnection | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  /** 满批排空：认领满批即连跑（吞吐不塌到「每个兜底周期一批」） */
  const drain = async (): Promise<void> => {
    for (let i = 0; i < guard; i++) {
      const claimed = await env.runBatch();
      if (claimed < env.batchSize) break;
    }
  };

  const coalescedRun = createCoalescedRunner(drain);

  const listen = async (): Promise<void> => {
    if (closed) return;
    const client = await env.connect();
    if (closed) {
      client.release();
      return;
    }
    connection = client;
    client.on('notification', (message) => {
      if (message.channel !== env.channel) return;
      // 载荷 requestId 不解析（纯门铃）；唤醒合并进 coalescedRun
      void coalescedRun().catch((error: unknown) => {
        env.logger.error({ err: String(error) }, 'settle wake run failed (sweep covers)');
      });
    });
    client.on('error', (error) => {
      env.logger.warn(
        { err: String(error) },
        'settle wake listener dropped (sweep covers), reconnecting',
      );
      scheduleReconnect();
    });
    // 通道名按标识符转义（'settle-wake' 含连字符——裸 LISTEN 是 42601 语法错）
    await client.query(`LISTEN "${env.channel.replace(/"/g, '""')}"`);
    attempt = 0;
  };

  const scheduleReconnect = (): void => {
    if (closed) return;
    const delay = Math.min(backoff.baseMs * 2 ** attempt, backoff.maxMs);
    attempt += 1;
    connection = null;
    if (reconnectTimer != null) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void listen().catch((error: unknown) => {
        env.logger.warn({ err: String(error) }, 'settle wake reconnect failed (sweep covers)');
        scheduleReconnect();
      });
    }, delay);
    reconnectTimer.unref();
  };

  void listen().catch((error: unknown) => {
    env.logger.error({ err: String(error) }, 'settle wake listener start failed (sweep covers)');
    scheduleReconnect();
  });

  return {
    coalescedRun,
    async close() {
      closed = true;
      if (reconnectTimer != null) clearTimeout(reconnectTimer);
      connection?.release();
      connection = null;
    },
  };
}
