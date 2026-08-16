import { randomUUID } from 'node:crypto';
import type { Db } from '@ai-gateway/db';
import type {
  AuthorizeBillingCommand,
  BillingAuthorization,
  BillingEvent,
  BillingSignalResult,
  ChannelReservationResult,
  ReserveChannelCommand,
} from './types.js';
import { authorize, createAdmission, type AdmissionGate } from './authorize/index.js';
import { reserveChannel } from './channel-reserve.js';
import { signalEvent } from './signal/index.js';

/**
 * 企业计费门面（装配层，目录化：signal/ 逐事件、authorize / channel-reserve /
 * quote / errors 同级模块由本入口组装）。
 * PostgreSQL 是唯一事实源；队列只发送 requestId 唤醒结算处理器。
 * 实现分布：authorize.ts（授权预扣）/ channel-reserve.ts（渠道进货硬闸）/
 * signal.ts（状态机事件）/ quote.ts（报价与收据校验纯函数）/ errors.ts（域错误）。
 */
export interface Billing {
  authorize(command: AuthorizeBillingCommand): Promise<BillingAuthorization>;
  /** 渠道「进货额度」精确硬闸：选渠前预留在途上游成本敞口（换渠道原子释放旧敞口）。 */
  reserveChannel(command: ReserveChannelCommand): Promise<ChannelReservationResult>;
  signal(event: BillingEvent): Promise<BillingSignalResult>;
}

export interface BillingDeps {
  db: Db;
  clock?: () => Date;
  admission?: AdmissionGate;
}

export function createBilling({ db, clock = () => new Date(), admission }: BillingDeps): Billing {
  const admissionGate = admission ? createAdmission(db, admission) : undefined;
  return {
    authorize: (command) => authorize(db, clock, admissionGate, command),
    reserveChannel: (command) => reserveChannel(db, clock, command),
    signal: (event) => signalEvent(db, clock, event),
  };
}

export function newLeaseOwner(): string {
  return randomUUID();
}
