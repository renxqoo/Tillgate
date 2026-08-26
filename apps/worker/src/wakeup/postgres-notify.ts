/**
 * 结算唤醒消费端（bun-native：Bun SQL sql.listen）：
 *   - sql.listen 订阅 settle-wake——Bun 自管监听专用连接（首个 listen 打开、
 *     最后一个 unlisten 关闭；中途断线由 Bun 指数退避重连并自动重订阅，
 *     官方类型文档语义），不占业务池、无需自建连接事件机；
 *   - 通知 payload 是 requestId → 定向入队（BullMQ jobId=requestId 幂等）；
 *     payload 缺失/非 UUID → 触发一次 sweep 兜底（网关旧形态/误发均可吸收）；
 *   - 启动失败（listen promise reject）→ 本模块指数退避重试（封顶 30s）。
 *     通道故障期间结算由 sweep 周期兜底——账务不依赖消息（认领/幂等全在 DB）。
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** LISTEN 订阅句柄的最小结构面（Bun SQL ListenSubscription 子集；测试注入假订阅） */
export interface WakeSubscription {
  unlisten(): Promise<void>;
}

export interface SettleWakeListener {
  close(): Promise<void>;
}

interface SettleWakeListenerEnv {
  /** 订阅通道；onMessage 收到该通道每条通知的 payload 文本 */
  listen(
    channel: string,
    onMessage: (payload: string) => void,
  ): Promise<WakeSubscription>;
  channel: string;
  /** 唤醒处理：payload 是 requestId（已验 UUID 形状）或 null（触发 sweep 兜底） */
  onWake: (requestId: string | null) => Promise<void>;
  logger: { warn(obj: unknown, msg: string): void; error(obj: unknown, msg: string): void };
  /** 启动失败重试退避（缺省 1s 起、×2、封顶 30s） */
  backoff?: { baseMs: number; maxMs: number };
}

// eslint-disable-next-line max-lines-per-function -- LISTEN 唤醒监听闭包工厂:onMessage/start/scheduleRetry/close 共享 closed/subscription/retryTimer/attempt 状态,拆分即互相回读(存量棘轮)
export function createSettleWakeListener(env: SettleWakeListenerEnv): SettleWakeListener {
  const backoff = env.backoff ?? { baseMs: 1_000, maxMs: 30_000 };

  let closed = false;
  let subscription: WakeSubscription | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  const onMessage = (payloadRaw: string): void => {
    const payload = (payloadRaw ?? '').trim();
    const requestId = UUID_RE.test(payload) ? payload : null;
    if (requestId == null && payload !== '') {
      env.logger.warn(
        { payload: payload.slice(0, 64) },
        'settle wake payload not a requestId, falling back to sweep',
      );
    }
    void env
      .onWake(requestId)
      .catch((error: unknown) => env.logger.error({ err: String(error) }, 'settle wake enqueue failed (sweep covers)'));
  };

  const start = async (): Promise<void> => {
    if (closed) return;
    const sub = await env.listen(env.channel, onMessage);
    if (closed) {
      // close 与建连竞态：晚到的订阅立即拆除（不泄漏监听连接）
      await sub.unlisten().catch(() => {});
      return;
    }
    subscription = sub;
    attempt = 0;
  };

  const scheduleRetry = (): void => {
    if (closed) return;
    const delay = Math.min(backoff.baseMs * 2 ** attempt, backoff.maxMs);
    attempt += 1;
    subscription = null;
    if (retryTimer != null) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void start().catch((error: unknown) => {
        env.logger.warn({ err: String(error) }, 'settle wake listen failed (sweep covers), retrying');
        scheduleRetry();
      });
    }, delay);
    retryTimer.unref();
  };

  void start().catch((error: unknown) => {
    env.logger.error({ err: String(error) }, 'settle wake listener start failed (sweep covers)');
    scheduleRetry();
  });

  return {
    async close() {
      closed = true;
      if (retryTimer != null) clearTimeout(retryTimer);
      const sub = subscription;
      subscription = null;
      await sub?.unlisten().catch(() => {});
    },
  };
}
