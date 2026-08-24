/**
 * 连接与生命周期:池创建、健康探测、优雅收口。
 *
 * 零隐藏默认(铁律 3):连接串与全部池参数必填注入,装配层(app config)持有缺省值;
 * v1 的默认连接串与池默认 max=20(与 app 默认 10 形成两套真相)已删除(B2/IMPLEMENTATION.md)。
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { InfrastructureError } from '@tillgate/errors';
import * as schema from './schema/index.js';

/** 池配置(全部必填——语义注释承接 v1 实测值:生产常用 20/30_000/5_000/1_000) */
export interface DbPoolConfig {
  /** 连接串;并行测试约束:worker 数 × poolMax < PG max_connections */
  readonly url: string;
  /** 连接池上限(按实例数 × 并发预估,防打爆 PG max_connections) */
  readonly poolMax: number;
  /** 空闲连接回收毫秒数(防泄漏) */
  readonly idleTimeoutMillis: number;
  /** 取连接超时毫秒数(DB 不可用时快速失败而非无限等待) */
  readonly connectionTimeoutMillis: number;
  /** 单连接最大使用次数(防长连接内存泄漏,达限回收重建) */
  readonly maxUses: number;
}

/**
 * 建立 Drizzle 实例。传 schema 使 db.query.* 有完整类型并支持 relational queries(with: {...})。
 * 池对象不外泄——生命周期仅经 ping/closeDb(DESIGN.md §1)。
 */
export function createDb(config: DbPoolConfig) {
  const pool = new pg.Pool({
    connectionString: config.url,
    max: config.poolMax,
    idleTimeoutMillis: config.idleTimeoutMillis,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    maxUses: config.maxUses,
  });
  return drizzle(pool, { schema });
}

export type Db = ReturnType<typeof createDb>;

/** drizzle 事务句柄(事务内执行的统一参数类型;用例层持有事务、repo 层接收) */
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * 健康探测:select 1(healthz/readyz 用;v1 worker readyz 不 ping DB 的差异在 apps/worker 迁移时修正,C2)。
 * 失败即 db 自产的基础设施错误,按根契约源头分类(AGENT.md §11 / errors README §2.2):
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

/** 池优雅收口:进程 shutdown 专用——v1 在五个 app 的 shutdown 里近似拷贝,此处收敛(C1) */
export function closeDb(db: Db): Promise<void> {
  return db.$client.end();
}
