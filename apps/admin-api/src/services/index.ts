import type { Db } from '@ai-gateway/db';
import type { BillingOperations, Ledger } from '@ai-gateway/ledger';
import type { Logger } from '@ai-gateway/core';
import type { Redis } from '@ai-gateway/http';
import type { VoucherStorage } from './voucher-storage.js';

/**
 * admin-api 服务依赖集合（依赖注入的唯一入口）。
 *
 * 路由/服务只接收本对象，不直读 process.env / 全局单例，
 * 测试可以注入 mock 或真实实例，无需 vi.mock 全局模块。
 */
export interface AdminServices {
  db: Db;
  redis: Redis;
  ledger: Ledger;
  billingOperations: BillingOperations;
  /** 渠道上游 Key 加密密钥（AES-256-GCM） */
  encryptionKey: string;
  /** 凭证截图存储（本地磁盘/未来 OSS） */
  voucherStorage: VoucherStorage;
  logger: Logger;
}
