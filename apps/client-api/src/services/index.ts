import type { Db } from '@ai-gateway/db';
import type { Ledger } from '@ai-gateway/ledger';
import type { Logger } from '@ai-gateway/core';
import type { Redis } from '@ai-gateway/http';
import type { Mailer } from '@ai-gateway/identity';

/**
 * client-api 服务依赖集合（依赖注入的唯一入口）。
 * 路由/服务只接收本对象，不直读 process.env / 全局单例。
 */
export interface ClientServices {
  db: Db;
  redis: Redis;
  ledger: Ledger;
  logger: Logger;
  /** 登录验证码发信；null = SMTP 未配置 → 登录 fail-closed 503 */
  mailer: Mailer | null;
}
