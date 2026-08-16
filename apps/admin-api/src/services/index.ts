import type { Db } from '@ai-gateway/db';
import type { Mailer } from '@ai-gateway/identity';
import type { BillingOperations, Ledger } from '@ai-gateway/ledger';
import type { TraceStore } from '@ai-gateway/tracing';
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
  /** 链路追踪存储（trace-receiver 写入，管理台查询） */
  tracingStore: TraceStore;
  /** 渠道上游 Key 加密密钥（AES-256-GCM） */
  /** 邮箱验证码发信（未配置 SMTP = null，2FA fail-closed） */
  mailer: Mailer | null;
  encryptionKey: string;
  encryptionKeyOld?: string;
  /** 凭证截图存储（本地磁盘/未来 OSS） */
  voucherStorage: VoucherStorage;
  /**
   * 渠道测试探活是否放行内网上游（ALLOW_LOCAL_UPSTREAM && 非生产，
   * 与网关同一双重门控——否则管理台测 LAN/本地渠道永远误报 network）。
   */
  allowLocalUpstream: boolean;
  logger: Logger;
}
