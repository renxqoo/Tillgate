/**
 * Redis 客户端工厂（装配统一入口）：错误监听 + 去重日志。
 *
 * REDIS_URL 已配置但 Redis 不可达时，ioredis 默认行为是无限重连并周期性抛
 * 「Unhandled error event」——没有监听器时刷屏且语义不明。工厂挂上监听：
 * 首次（及每 30s 一次）打一条带降级语义的日志，静默其余重试噪声。
 * 业务语义不变：限流/爆破防护 fail-open、免费日限 fail-closed（各自模块内）。
 */
import { Redis } from 'ioredis';

/** 日志脱敏：URL 带认证信息时抹掉（redis://:pass@host → redis://***@host） */
function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return url;
  }
}

/** 可读错误描述：AggregateError（多地址都失败）的 message 是空串——展开内层原因 */
function describeError(err: Error): string {
  const inner = (err as { errors?: Error[] }).errors;
  if (!err.message && inner?.length) {
    return `${err.name}（${inner.map((e) => e.message).join('; ')}）`;
  }
  return err.message || err.name;
}

export interface RedisClientOptions {
  /** 日志前缀（服务名） */
  serviceName: string;
  /** 重复错误日志的最小间隔（ms；缺省 30s） */
  logThrottleMs?: number;
}

export function createRedisClient(url: string, options: RedisClientOptions): Redis {
  const redis = new Redis(url, {
    // 单条命令的失败快速返回（fail-open 语义在调用方：不因离线队列挂死请求）
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  let lastLoggedAt = 0;
  const throttleMs = options.logThrottleMs ?? 30_000;
  redis.on('error', (err: Error) => {
    const now = Date.now();
    if (now - lastLoggedAt < throttleMs) return;
    lastLoggedAt = now;
    console.error(
      `[${options.serviceName}] Redis 不可达（${sanitizeUrl(url)}）：${describeError(err)}——持续重试中；` +
        '限流/爆破防护 fail-open 降级，免费模型日限 fail-closed（503）',
    );
  });
  return redis;
}

/**
 * 启动期连通性验证（Redis 是首选组件：连不上 = 拒绝启动）。
 * 带 5s 上界——避免 hang 在网络黑洞上；错误信息带脱敏 URL 便于直接排查。
 */
/** 测试/装配辅助：等冷连接就绪（offline queue 关闭时首个命令会拒绝）；超时返回 false */
export async function waitForRedisReady(redis: Redis, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await redis.ping()) === 'PONG') return true;
    } catch {
      /* 未就绪，继续等 */
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * 启动期连通性验证（Redis 是首选组件：连不上 = 拒绝启动）。
 * 冷连接友好：客户端关闭了 offline queue（连接就绪前的命令立即拒绝），
 * 因此用「重试直至截止」而非单发 ping；超时报错带脱敏 URL 便于直接排查。
 */
export async function assertRedisReachable(
  redis: Redis,
  serviceName: string,
  rawUrl: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | null = null;
  for (;;) {
    try {
      if ((await redis.ping()) === 'PONG') return;
    } catch (err) {
      lastError = err as Error;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `[${serviceName}] Redis 启动验证失败（${sanitizeUrl(rawUrl)}）：${describeError(lastError ?? new Error(`ping 超时（${timeoutMs}ms）`))}——` +
      'Redis 为必配组件，拒绝以降级形态启动（检查 REDIS_URL 与 Redis 实例）',
  );
}
