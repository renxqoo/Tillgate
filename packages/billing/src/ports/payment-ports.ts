/**
 * 支付与兑换 port 集：渠道 provider 协议口 + payment_orders/redeem_codes 存储 +
 * 频率闸（Redis 计数器由 runtime 提供——此处只依赖行为口）。
 * epay/stripe 适配在 adapters/payments；存储实现归 adapters/postgres。
 */
import type { WalletConn } from './wallet-store.js';

/** 支付渠道端口（协议适配；epay/stripe 按同口接入） */
export interface PaymentProviderPort {
  readonly name: 'epay' | 'stripe';
  /** 创建渠道支付（返回支付跳转 URL；providerOrderId 商户侧单号） */
  createOrder(input: {
    orderId: string;
    amount: string;
    subject: string;
  }): Promise<{ providerOrderId: string; payUrl: string }>;
  /**
   * 回调验签+归一：返回 null = 拒收（验签失败/状态非成功/缺字段）；
   * 金额核对在 application（需要订单真相）。raw 为验签材料包——
   * epay=回调 query/form 键值，stripe={payload: 原始事件体, 'stripe-signature': 头}
   */
  parseNotify(raw: Record<string, string>): {
    providerOrderId: string;
    /** 商户订单号回退锚（Stripe client_reference_id——attach 失败/竞态时按它定位订单） */
    merchantOrderId?: string;
    paidAmount: string;
  } | null;
}

export interface PaymentOrderRow {
  id: string;
  provider: string;
  providerOrderId: string;
  userId: number;
  amount: string;
  currency: string;
  creditAmount: string;
  status: number; // 0 created / 1 paid / 2 credited / 4 expired
  createdAt: Date;
}

export interface PaymentOrderStore {
  insertOrder(
    tx: WalletConn,
    input: {
      id: string;
      provider: string;
      providerOrderId: string;
      userId: number;
      amount: string;
      currency: string;
      creditAmount: string;
    },
  ): Promise<void>;
  attachProviderOrderId(
    tx: WalletConn,
    input: { orderId: string; providerOrderId: string },
  ): Promise<void>;
  findByProviderOrderId(
    conn: WalletConn,
    input: { provider: string; providerOrderId: string },
  ): Promise<PaymentOrderRow | null>;
  findById(conn: WalletConn, orderId: string): Promise<PaymentOrderRow | null>;
  findByUserAndId(
    conn: WalletConn,
    input: { userId: number; orderId: string },
  ): Promise<PaymentOrderRow | null>;
  listByUser(
    conn: WalletConn,
    input: { userId: number; limit: number; offset: number },
  ): Promise<PaymentOrderRow[]>;
  /** CAS 0→1（paid）；0 行 = 并发/乱序，返回 null 由调用方重读定夺 */
  markPaid(
    tx: WalletConn,
    input: { orderId: string; paidAt: Date },
  ): Promise<{ id: string; creditAmount: string; userId: number } | null>;
  /** CAS 1→2（credited） */
  markCredited(tx: WalletConn, input: { orderId: string; creditedAt: Date }): Promise<boolean>;
  /** 机会式关单：本用户超 TTL 未支付 → expired（只关自己的单） */
  expireOverdue(tx: WalletConn, input: { userId: number; createdBefore: Date }): Promise<void>;
  /** 过期单复活（4→1）：过期只是关单标记非资金事实——已验签金额一致即收尾入账 */
  reviveExpiredAsPaid(tx: WalletConn, input: { orderId: string; paidAt: Date }): Promise<boolean>;
  /** 渠道下单失败关单留痕（0→4，best-effort） */
  markChannelFailed(tx: WalletConn, orderId: string): Promise<void>;
}

export interface RedeemClaimRow {
  codeId: number;
  batchId: number;
  amount: string;
}

export interface RedeemCodeStore {
  /** 按哈希查码（错误语义区分用：无效码 vs 已用/吊销/过期） */
  findByCodeHash(
    conn: WalletConn,
    codeHash: string,
  ): Promise<{ id: number; batchId: number; status: number; expiresAt: Date | null } | null>;
  /** 核销 CAS：status=0 且未过期 → 1（并发同码唯一赢家） */
  claim(
    tx: WalletConn,
    input: { codeHash: string; userId: number; now: Date },
  ): Promise<RedeemClaimRow | null>;
  /** 批次+码同事务生成（管理面） */
  insertBatchWithCodes(
    tx: WalletConn,
    input: {
      batchName: string;
      amount: string;
      expiresAt: Date | null;
      createdBy: number;
      codeHashes: readonly string[];
    },
  ): Promise<{ batchId: number; codeIds: number[] }>;
  listRedeemedByUser(
    conn: WalletConn,
    input: { userId: number; limit: number; offset: number },
  ): Promise<Array<{ codeId: number; batchName: string; amount: string; usedAt: Date | null }>>;
}

/** 固定窗计数器（Redis 实现归 runtime 装配；不可达必须抛错——fail-closed） */
export interface RateCounterPort {
  /** 计一次并返回窗口内计数；实现不可达时抛错（防护组件不可用不裸奔） */
  hit(key: string, windowSeconds: number): Promise<number>;
}
