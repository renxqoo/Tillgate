/**
 * 预扣明细仓储（billing_reservations——资金来源瀑布的真相表）：
 * 明细行只在授权事务内写入（active）；释放/结算在调用方事务内逐笔改状态。
 * findActive 带账单状态 JOIN 过滤——旧 worker 结算/释放不操作本表，
 * 已 settled/released 账单的孤儿明细行不会被误释放（过渡期防线，§4.4）。
 */
import { and, eq, sql } from 'drizzle-orm';
import type { DbTx } from '@ai-gateway/db';
import { billingRequests, billingReservations } from '@ai-gateway/db';
import type { RepoContext } from './context.js';

function tx(c: RepoContext): DbTx {
  return c.db as DbTx;
}

export interface ReservationRow {
  id: number;
  billingRequestId: string;
  sourceType: string;
  sourceRefId: number | null;
  amount: string;
  status: string;
}

/** 账单仍在途（明细可释放/可结算）的状态集——dead 是死单待复核，预扣未了结 */
const IN_FLIGHT_REQUEST_STATUSES = [
  'authorized',
  'in_flight',
  'settlement_pending',
  'processing',
  'retry_wait',
  'dead',
] as const;

const RESERVATION_COLUMNS = {
  id: billingReservations.id,
  billingRequestId: billingReservations.billingRequestId,
  sourceType: billingReservations.sourceType,
  sourceRefId: billingReservations.sourceRefId,
  amount: billingReservations.amount,
  status: billingReservations.status,
};

/** 预扣明细仓储（无状态；方法统一接收 RepoContext——事务由用例层注入） */
export class BillingReservationRepository {
  /** 授权事务内写入一行 active 明细（金额必须 > 0——零金额不落行） */
  async insertActive(
    c: RepoContext,
    values: { billingRequestId: string; sourceType: string; sourceRefId: number | null; amount: string },
  ): Promise<number> {
    const [row] = await tx(c)
      .insert(billingReservations)
      .values({ ...values, status: 'active' })
      .returning({ id: billingReservations.id });
    return row!.id;
  }

  /**
   * 该请求全部在途明细（账单状态 JOIN 过滤；排序保证确定性——瀑布逆序释放）。
   * statuses 可覆盖：释放路径的调用方已在本事务把账单 CAS 成 released，
   * 须把它并入白名单（默认白名单只认在途——防已了结账单的孤儿明细被误操作）。
   */
  async findActive(
    c: RepoContext,
    billingRequestId: string,
    statuses: readonly string[] = IN_FLIGHT_REQUEST_STATUSES,
  ): Promise<ReservationRow[]> {
    const rows = await tx(c)
      .select(RESERVATION_COLUMNS)
      .from(billingReservations)
      .innerJoin(billingRequests, eq(billingRequests.requestId, billingReservations.billingRequestId))
      .where(
        and(
          eq(billingReservations.billingRequestId, billingRequestId),
          eq(billingReservations.status, 'active'),
          sql`${billingRequests.status} in ${statuses}`,
        ),
      )
      .orderBy(billingReservations.id);
    return rows as ReservationRow[];
  }

  /** active → released（释放路径逐笔；0 行 = 已非 active，事实脱节由调用方红灯） */
  async markReleased(c: RepoContext, id: number, now: Date): Promise<boolean> {
    const rows = await tx(c)
      .update(billingReservations)
      .set({ status: 'released', releasedAt: now })
      .where(and(eq(billingReservations.id, id), eq(billingReservations.status, 'active')))
      .returning({ id: billingReservations.id });
    return rows.length > 0;
  }

  /** active → settled（worker-v2 结算路径；接口先行，本仓库暂无调用方） */
  async markSettled(c: RepoContext, id: number, now: Date): Promise<boolean> {
    const rows = await tx(c)
      .update(billingReservations)
      .set({ status: 'settled', settledAt: now })
      .where(and(eq(billingReservations.id, id), eq(billingReservations.status, 'active')))
      .returning({ id: billingReservations.id });
    return rows.length > 0;
  }
}
