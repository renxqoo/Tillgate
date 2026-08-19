import type { Db } from '@ai-gateway/db';
import type { Mailer } from '@ai-gateway/identity';
import type { Wallet } from '@ai-gateway/wallet';
import type { SubscriptionDomain } from '@ai-gateway/ledger/subscription';
import type { ChannelBudget } from '@ai-gateway/ledger/channel-budget';
import type { BillingReview } from '@ai-gateway/ledger/billing';
import type { TraceStore } from '@ai-gateway/tracing';
import type { Logger } from '@ai-gateway/core';
import type { Redis } from '@ai-gateway/http';
import type { VoucherStorage } from './voucher-storage.js';
import type { AdminFunds } from './funds.js';

/**
 * admin-api 服务依赖集合（依赖注入的唯一入口；S7 重写：资金事实在 wallet，
 * 订阅/渠道/复核各自成域，旧 ledger 门面退役）。
 *
 * 路由/服务只接收本对象，不直读 process.env / 全局单例，
 * 测试可以注入 mock 或真实实例，无需 vi.mock 全局模块。
 */
export interface AdminServices {
  db: Db;
  redis: Redis;
  /** 资金动作（refTypes 白名单：admin/subscription/pack） */
  wallet: Wallet;
  /** 管理端调账/赠送/授信（wallet 之上，幂等走 ledger-core） */
  funds: AdminFunds;
  subscription: SubscriptionDomain;
  channelBudget: ChannelBudget;
  /** 死单人工复核 */
  billingReview: BillingReview;
  /** 链路追踪存储（trace-receiver 写入，管理台查询） */
  tracingStore: TraceStore;
  /** 邮箱验证码发信（未配置 SMTP = null，2FA fail-closed） */
  mailer: Mailer | null;
  /** 渠道上游 Key 加密密钥（AES-256-GCM） */
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
