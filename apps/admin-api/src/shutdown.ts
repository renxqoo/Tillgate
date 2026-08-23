/**
 * 优雅停机组装（目标树显式文件;runtime createShutdown 承担编排件本体）：
 * server.close → otel flush → closeables → redis → db,宽限上界强制退出。
 * redis 本波恒 null（DESIGN §2.4;P2 登录波装配后恢复）。
 */
import type { ServerType } from '@hono/node-server';
import type { Db } from '@tokenlens/db';
import { closeDb } from '@tokenlens/db';
import type { Logger } from '@tokenlens/runtime';
import { createShutdown } from '@tokenlens/runtime';
import type { OtelHandle } from '@tokenlens/observability';

export interface AdminShutdownDeps {
  readonly server: ServerType;
  readonly otel: OtelHandle;
  readonly db: Db;
  readonly graceMs: number;
  readonly logger: Logger;
  /** 退出函数注入缝(测试;缺省 process.exit) */
  readonly exit?: (code: number) => never;
}

export function createAdminShutdown(deps: AdminShutdownDeps): (signal: string) => void {
  return createShutdown({
    serviceName: 'admin-api',
    server: deps.server,
    otel: deps.otel,
    redis: null,
    db: { end: () => closeDb(deps.db) },
    graceMs: deps.graceMs,
    log: deps.logger,
    ...(deps.exit !== undefined ? { exit: deps.exit } : {}),
  });
}
