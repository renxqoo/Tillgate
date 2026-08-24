/**
 * Redis 客户端工厂（装配统一入口）——拆分自 v2 原 redis-client.ts（一动词一文件，铁律 5）。
 * 错误监听 + 去重日志；可变参数全部必填注入（铁律 3：logThrottleMs / sentinelName 不藏默认）。
 *
 * REDIS_URL 已配置但 Redis 不可达时，ioredis 默认行为是无限重连并周期性抛
 * 「Unhandled error event」——没有监听器时刷屏且语义不明。工厂挂上监听：
 * 首 次（及每 logThrottleMs 一次）打一条带降级语义的日志，静默其余重试噪声。
 * 各消费方的故障语义在其模块内（限流 fail-open、防护 degraded、日限 fail-closed）。
 */
import { Redis } from 'ioredis';
import { DefectError } from '@tillgate/errors';
import { parseSentinels } from './parse-sentinels';
import { describeError, sanitizeUrl } from './redis-diagnostics';

/** Sentinel 拓扑判别联合：提供 sentinels 时 sentinelName 必填（'mymaster' 不做藏默认） */
export type SentinelTopology =
  | {
      readonly sentinels?: undefined;
      readonly sentinelName?: undefined;
      readonly sentinelPassword?: undefined;
    }
  | {
      /**
       * Sentinel 拓扑（HA 形态）："h1:26379,h2:26379,h3:26379"——提供时以 sentinel
       * 模式连接（自动发现主库、主从切换自动跟随）；缺省按 url 直连单实例。
       * 数据节点的密码与 db 仍取自 url（url 继续作为凭证载体，sentinels 只描述拓扑）。
       */
      readonly sentinels: string;
      /** sentinel 监视的 master 名（sentinel 形态必填） */
      readonly sentinelName: string;
      /** sentinel 节点自身的密码（sentinel requirepass 时需要） */
      readonly sentinelPassword?: string;
    };

export type RedisClientOptions = {
  /** 日志前缀（服务名） */
  serviceName: string;
  /** 重复错误日志的最小间隔（ms）——必填注入（部署可变值，铁律 3） */
  logThrottleMs: number;
  /** 降级日志出口（缺省 console.error）；注入以统一日志面与可测性（IMPLEMENTATION.md §2.1 B2） */
  log?: (message: string) => void;
} & SentinelTopology;

/** 从 url 提取数据节点凭证（sentinel 模式复用 REDIS_URL 的 password/db）；db 段非法抛错（P3 加固） */
function urlCredentials(url: string): { password?: string; db?: number } {
  try {
    const parsed = new URL(url);
    const password = parsed.password || undefined;
    if (parsed.pathname.length > 1) {
      const dbSegment = parsed.pathname.slice(1);
      const db = Number(dbSegment);
      // db 号 NaN/非负整数守卫：NaN 一路传给 ioredis 会在运行期炸出难定位错误——装配期拦截
      if (!Number.isInteger(db) || db < 0) {
        throw new DefectError(
          `invalid Redis database number in URL path: ${dbSegment} (expected non-negative integer)`,
          'runtime.redis.url_invalid',
          { db: dbSegment },
        );
      }
      return { password, db };
    }
    return { password };
  } catch (error) {
    if (error instanceof DefectError) throw error;
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
        name: options.sentinelName,
        ...(options.sentinelPassword ? { sentinelPassword: options.sentinelPassword } : {}),
        ...urlCredentials(url),
      })
    : new Redis(url, commandOptions);
  const log = options.log ?? ((message: string) => console.error(message));
  let lastLoggedAt = 0;
  redis.on('error', (err: Error) => {
    const now = Date.now();
    if (now - lastLoggedAt < options.logThrottleMs) return;
    lastLoggedAt = now;
    log(
      `[${options.serviceName}] Redis 不可达（${sanitizeUrl(url)}）：${describeError(err)}——持续重试中；` +
        '限流 fail-open 降级、爆破防护 degraded（本地粗限）、免费模型日限 fail-closed（503）',
    );
  });
  return redis;
}
