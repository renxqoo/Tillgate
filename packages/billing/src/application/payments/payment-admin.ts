/**
 * 支付订单管理面用例（admin-api P4;v1 ops-logs.service paymentOrders/closePaymentOrder
 * 迁入）：管理列表（用户面 listOrders 语义对照——无 userId 强制、q 双锚、排序白名单）
 * + 手动关单（过期/僵尸单的 CAS 0→4,幂等语义逐条保留——非 created 状态一律
 * order_state_conflict,重复关单第二次同样拒绝）。渠道凭证零依赖,与
 * createPaymentsApi 分立（管理面无需 provider/钱包入账编排）。
 */
import { BillingErrors } from '../../domain/errors.js';
import type { BillingStore } from '../../ports/billing-store.js';
import type {
  AdminPaymentOrderRow,
  PaymentOrderSortField,
  PaymentOrderStore,
} from '../../ports/payment-ports.js';

export interface PaymentAdminDeps {
  /** 会话来源（billing store 装配件;关单是单语句 CAS,无跨语句编排） */
  store: Pick<BillingStore, 'read' | 'transaction'>;
  orders: Pick<PaymentOrderStore, 'listAdminOrders' | 'closeOrder'>;
}

export interface PaymentAdminQuery {
  q?: string;
  sortBy: PaymentOrderSortField;
  order: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export interface PaymentAdminApi {
  /** 管理列表（用户列左联;total 恒全量） */
  list(query: PaymentAdminQuery): Promise<{ rows: AdminPaymentOrderRow[]; total: number }>;
  /**
   * 手动关单：CAS 0→4（failureReason = reason,由装配注入——审计留痕文案属
   * 装配层显式持有,铁律 3）。0 行命中（已付/已入账/已关/不存在）→
   * order_state_conflict（调用方映射 409——v1 conflict 语义）。
   */
  close(input: { orderId: string; reason: string }): Promise<{ ok: true }>;
}

export function createPaymentAdminApi(deps: PaymentAdminDeps): PaymentAdminApi {
  const { store, orders } = deps;
  return {
    list: (query) => store.read((conn) => orders.listAdminOrders(conn, query)),
    async close(input) {
      // 单语句 CAS 自原子;经事务会话以保持写路径一致形态(与 markPaid 同款)
      const closed = await store.transaction((tx) => orders.closeOrder(tx, input));
      if (!closed) {
        throw BillingErrors.business('order_state_conflict', { orderId: input.orderId });
      }
      return { ok: true as const };
    },
  };
}
