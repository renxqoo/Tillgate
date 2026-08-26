/**
 * 结算唤醒消费端（2026-08-26 BullMQ 增量重写）：
 *   - 专用连接（db.$client.connect()，不进池循环）LISTEN settle-wake；
 *   - 通知 payload 是 requestId → 定向入队（BullMQ jobId=requestId 幂等）；
 *     payload 缺失/非 UUID → 触发一次 sweep 兜底（网关旧形态/误发均可吸收）；
 *   - 入队廉价，无需 coalescing/drain（BullMQ 逐条消费天然排空；
 *     原 v1 批处理语义随 BullMQ 增量移除）；
 *   - 断线重连：连接 error/end → 指数退避重连（封顶 30s）。通道故障期间
 *     结算由 sweep 周期兜底——账务不依赖消息（认领/幂等全在 DB）。
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SettleWakeListener {
  close(): Promise<void>;
}

interface SettleWakeListenerEnv {
  connect: () => Promise<ListenConnection>;
  channel: string;
  /** 唤醒处理：payload 是 requestId（已验 UUID 形状）或 null（触发 sweep 兜底） */
  onWake: (requestId: string | null) => Promise<void>;
  logger: { warn(obj: unknown, msg: string): void; error(obj: unknown, msg: string): void };
  /** 重连退避（缺省 1s 起、×2、封顶 30s） */
  backoff?: { baseMs: number; maxMs: number };
}

// eslint-disable-next-line max-lines-per-function -- LISTEN 唤醒监听闭包工厂:listen/scheduleReconnect/close 共享 closed/connection/attempt 重连状态,拆分即互相回读(存量棘轮)
export function createSettleWakeListener(env: SettleWakeListenerEnv): SettleWakeListener {
  const backoff = env.backoff ?? { baseMs: 1_000, maxMs: 30_000 };

  let closed = false;
  let connection: ListenConnection | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

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
      const payload = (message.payload ?? '').trim();
      const requestId = UUID_RE.test(payload) ? payload : null;
      if (requestId == null && payload !== '') {
        env.logger.warn({ payload: payload.slice(0, 64) }, 'settle wake payload not a requestId, falling back to sweep');
      }
      void env
        .onWake(requestId)
        .catch((error: unknown) => env.logger.error({ err: String(error) }, 'settle wake enqueue failed (sweep covers)'));
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
    async close() {
      closed = true;
      if (reconnectTimer != null) clearTimeout(reconnectTimer);
      connection?.release();
      connection = null;
    },
  };
}
