/**
 * Redis 连接目标解析：URL 持有数据节点密码/db，Sentinel 组只持有拓扑。
 * 本文件不创建连接，普通请求客户端与 BullMQ 可在同一目标上叠加不同重试策略。
 */
import { DefectError } from '@tillgate/errors';
import { parseSentinels } from './parse-sentinels';

/** Sentinel 拓扑判别联合：提供节点时 master name 必填。 */
export type SentinelTopology =
  | {
      readonly sentinels?: undefined;
      readonly sentinelName?: undefined;
      readonly sentinelPassword?: undefined;
    }
  | {
      readonly sentinels: string;
      readonly sentinelName: string;
      readonly sentinelPassword?: string;
    };

export type RedisConnectionTarget =
  | { readonly kind: 'direct'; readonly url: string }
  | {
      readonly kind: 'sentinel';
      /** 只暴露跨 ioredis 主版本稳定的 Sentinel 参数，避免基础包类型泄漏。 */
      readonly options: {
        readonly sentinels: { readonly host: string; readonly port: number }[];
        readonly name: string;
        readonly sentinelPassword?: string;
        readonly password?: string;
        readonly db?: number;
      };
    };

/** 从 URL 提取 Sentinel 模式的数据节点凭据；非法 db 在装配期拒绝。 */
function urlCredentials(url: string): { password?: string; db?: number } {
  try {
    const parsed = new URL(url);
    const password = parsed.password || undefined;
    if (parsed.pathname.length <= 1) return { password };
    const dbSegment = parsed.pathname.slice(1);
    const db = Number(dbSegment);
    if (!Number.isInteger(db) || db < 0) {
      throw new DefectError(
        `invalid Redis database number in URL path: ${dbSegment} (expected non-negative integer)`,
        'runtime.redis.url_invalid',
        { db: dbSegment },
      );
    }
    return { password, db };
  } catch (error) {
    if (error instanceof DefectError) throw error;
    return {};
  }
}

export function resolveRedisConnection(
  url: string,
  topology: SentinelTopology,
): RedisConnectionTarget {
  if (topology.sentinels == null) return { kind: 'direct', url };
  return {
    kind: 'sentinel',
    options: {
      sentinels: parseSentinels(topology.sentinels),
      name: topology.sentinelName,
      ...(topology.sentinelPassword != null ? { sentinelPassword: topology.sentinelPassword } : {}),
      ...urlCredentials(url),
    },
  };
}
