/**
 * 优雅停机组装（目标树显式文件;runtime createShutdown 承担编排件本体）：
 * server.close → otel flush → closeables → redis → db,宽限上界强制退出。
 * P2 登录波装配后 Redis 收口恢复（守卫双闸/jti 吊销面连接 quit）。
 */
import type { AppServer } from '@tillgate/http';
import type { Db } from '@tillgate/db';
import { closeDb } from '@tillgate/db';
import type { Logger } from '@tillgate/runtime';
import { createShutdown } from '@tillgate/runtime';
import type { OtelHandle } from '@tillgate/observability';

export interface AdminShutdownDeps {
  readonly server: AppServer;
  readonly otel: OtelHandle;
  /** P2:Redis 连接收口（守卫双闸/jti 吊销面;quit 优雅断连） */
  readonly redis: { quit(): Promise<unknown> };
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
    redis: deps.redis,
    db: { end: () => closeDb(deps.db) },
    graceMs: deps.graceMs,
    log: deps.logger,
    ...(deps.exit !== undefined ? { exit: deps.exit } : {}),
  });
}
