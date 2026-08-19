/** 健康检查仓储：DB 连通性探针（app /healthz 消费——SQL 归 repository 铁律不变）。 */
import { sql } from 'drizzle-orm';
import type { RepoContext } from './context.js';

export class HealthRepository {
  /** 连通即通过（select 1）；失败原样上抛由 app 翻 503 */
  async ping(c: RepoContext): Promise<void> {
    await c.db.execute(sql`select 1`);
  }
}
