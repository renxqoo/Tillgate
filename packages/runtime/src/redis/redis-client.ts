/**
 * Redis 客户端工厂（装配统一入口）：错误监听 + 去重日志 + 启动连通性验证。
 *
 * REDIS_URL 已配置但 Redis 不可达时，ioredis 默认行为是无限重连并周期性抛
 * 「Unhandled error event」——没有监听器时刷屏且语义不明。工厂挂上监听：
 * 首次（及每 logThrottleMs 一次）打一条带降级语义的日志，静默其余重试噪声。
 * 各消费方的故障语义在其模块内（限流 fail-open、防护 degraded、日限 fail-closed）。
 */
import { Redis } from 'ioredis';
import { DefectError, InfrastructureError } from '@tokenlens/errors';

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
  /**
   * Sentinel 拓扑（HA 形态）："h1:26379,h2:26379,h3:26379"——提供时以 sentinel
   * 模式连接（自动发现主库、主从切换自动跟随）；缺省按 url 直连单实例。
   * 数据节点的密码与 db 仍取自 url（url 继续作为凭证载体，sentinels 只描述拓扑）。
   */
  sentinels?: string;
  /** sentinel 监视的 master 名（缺省 mymaster） */
  sentinelName?: string;
  /** sentinel 节点自身的密码（sentinel requirepass 时需要） */
  sentinelPassword?: string;
  /** 降级日志出口（缺省 console.error）；注入以统一日志面与可测性（IMPLEMENTATION.md §2.1 B2） */
  log?: (message: string) => void;
}

/** sentinel 拓扑串解析："h:26379,h:26379" → [{host, port}]（非法项抛错——装配期 fail-fast） */
export function parseSentinels(spec: string): { host: string; port: number }[] {
  const nodes = spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((node) => {
      // lastIndexOf 切分（而非 split）：IPv6 形态 [::1]:26379 只切末段端口
      const idx = node.lastIndexOf(':');
      const host = idx > 0 ? node.slice(0, idx) : node;
      const port = Number(idx > 0 ? node.slice(idx + 1) : '26379');
      if (!host || !Number.isInteger(port) || port <= 0) {
        throw new DefectError(
          `REDIS_SENTINELS 非法节点：${node}（期望 host:port 逗号分隔）`,
          'runtime.redis.sentinels_invalid',
          { node },
        );
      }
      return { host, port };
    });
  if (nodes.length === 0) {
    throw new DefectError(
      'REDIS_SENTINELS 为空（期望 host:port 逗号分隔）',
      'runtime.redis.sentinels_invalid',
    );
  }
  return nodes;
}

/** 从 url 提取数据节点凭证（sentinel 模式复用 REDIS_URL 的 password/db） */
function urlCredentials(url: string): { password?: string; db?: number } {
  try {
    const parsed = new URL(url);
    return {
      password: parsed.password || undefined,
      db:
        parsed.pathname && parsed.pathname.length > 1
          ? Number(parsed.pathname.slice(1))
          : undefined,
    };
  } catch {
    return {};
  }
}

export function createRedisClient(url: string, options: RedisClientOptions): Redis {
  // 单条命令的失败快速返回（fail-open 语义在调用方：不因离线队列挂死请求）；
  // sentinel 模式同样适用——主从切换期间命令快速失败，请求不挂死
  const commandOptions = { maxRetriesPerRequest: 1, enableOfflineQueue: false } as const;
  const redis = options.sentinels
    ? new Redis({
        ...commandOptions,
        sentinels: parseSentinels(options.sentinels),
        name: options.sentinelName ?? 'mymaster',
        ...(options.sentinelPassword ? { sentinelPassword: options.sentinelPassword } : {}),
        ...urlCredentials(url),
      })
    : new Redis(url, commandOptions);
  const log = options.log ?? ((message: string) => console.error(message));
  let lastLoggedAt = 0;
  const throttleMs = options.logThrottleMs ?? 30_000;
  redis.on('error', (err: Error) => {
    const now = Date.now();
    if (now - lastLoggedAt < throttleMs) return;
    lastLoggedAt = now;
    log(
      `[${options.serviceName}] Redis 不可达（${sanitizeUrl(url)}）：${describeError(err)}——持续重试中；` +
        '限流 fail-open 降级、爆破防护 degraded（本地粗限）、免费模型日限 fail-closed（503）',
    );
  });
  return redis;
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
  throw new InfrastructureError(
    `[${serviceName}] Redis 启动验证失败（${sanitizeUrl(rawUrl)}）：${describeError(lastError ?? new Error(`ping 超时（${timeoutMs}ms）`))}——` +
      'Redis 为必配组件，拒绝以降级形态启动（检查 REDIS_URL 与 Redis 实例）',
    'runtime.redis.unreachable',
    { serviceName, url: sanitizeUrl(rawUrl) },
    { cause: lastError ?? undefined },
  );
}
