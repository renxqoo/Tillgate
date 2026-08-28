/**
 * 连接与生命周期:池创建、健康探测、优雅收口。
 *
 * bun-native 形态:驱动为 Bun 原生 SQL(`import { SQL } from 'bun'`)+ drizzle
 * bun-sql 会话——不经 node 兼容层。类型映射与 pg 缺省一致(numeric→string、
 * timestamptz→Date、bigint→string,实测);SQLSTATE 在错误的
 * `errno` 字段(pg 在 `code`——pg-error.ts 沿 cause 链双字段探测)。
 *
 * 零隐藏默认:连接串与全部池参数必填注入,装配层(app config)持有缺省值。
 * pg 的 maxUses(按查询次数回收连接)无 Bun 对应——其 maxLifetime 按秒计是另一
 * 维度,不做假映射;字段移除,连接寿命不设限(等价 pg maxUses 缺省=不限)。
 * 毫秒入参按秒向上取整(Bun 池参数以秒为粒度,亚秒值会退化为 0=禁用)。
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sql';
import { InfrastructureError } from '@tillgate/errors';
import * as schema from './schema/index.js';

/**
 * Bun SQL 取全局而非 `import { SQL } from 'bun'`:源码经 vitest(Vite)转换时
 * 'bun' 是运行时内建、非可解析包名;全局在 bun 运行时(dev/test/dist)恒可用,
 * node_modules 内驱动(如 drizzle bun-sql)的 'bun' import 会被外部化、原生解析。
 */
const { SQL } = Bun;

/** 池配置(全部必填;生产常用 20/30_000/5_000) */
export interface DbPoolConfig {
  /** 连接串;并行测试约束:worker 数 × poolMax < PG max_connections */
  readonly url: string;
  /** 连接池上限(按实例数 × 并发预估,防打爆 PG max_connections) */
  readonly poolMax: number;
  /** 空闲连接回收毫秒数(防泄漏) */
  readonly idleTimeoutMillis: number;
  /** 取连接超时毫秒数(DB 不可用时快速失败而非无限等待) */
  readonly connectionTimeoutMillis: number;
}

/**
 * 建立 Drizzle 实例。传 schema 使 db.query.* 有完整类型并支持 relational queries(with: {...})。
 * 池对象不外泄——生命周期仅经 ping/closeDb。
 */
export function createDb(config: DbPoolConfig) {
  const client = new SQL(config.url, {
    max: config.poolMax,
    idleTimeout: Math.max(1, Math.ceil(config.idleTimeoutMillis / 1_000)),
    connectionTimeout: Math.max(1, Math.ceil(config.connectionTimeoutMillis / 1_000)),
  });
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof createDb>;

/** drizzle 事务句柄(事务内执行的统一参数类型;用例层持有事务、repo 层接收) */
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * 健康探测:select 1(healthz/readyz 用)。
 * 失败即 db 自产的基础设施错误,按根契约源头分类:
 * InfrastructureError 自由码 + cause 链保留底层事实;pg SQLSTATE 原样可达(pg-error 全链探测)。
 */
export async function ping(db: Db): Promise<void> {
  try {
    await db.execute(sql`select 1`);
  } catch (error) {
    throw new InfrastructureError('Database ping failed', 'db.unavailable', undefined, {
      cause: error,
    });
  }
}

/** 池优雅收口:进程 shutdown 专用 */
export function closeDb(db: Db): Promise<void> {
  return db.$client.end();
}
