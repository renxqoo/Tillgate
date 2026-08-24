/**
 * NotifyStore port:渠道 CRUD 与 outbox 五动词的持久化边界(DESIGN §4)。
 * 表族 = notification_channels(订阅配置)与 notify_outbox(事务发件箱);DDL 在 @tillgate/db。
 * 认领/终态/进度的 fencing 语义(三列 CAS + clock_timestamp)由实现承载——
 * 内存替身必须模拟同语义(单认领赢家、租约过期零效果),真实语义由 postgres.real.test.ts 锁定。
 * 入箱不做词表过滤(保留合成事件测试能力,B5);词表门在 application enqueue。
 */
import type { DbLike } from '@tillgate/db';
import type { NotificationChannel, ChannelType } from '../domain/channel';

export interface ChannelInsertInput {
  readonly name: string;
  readonly type: ChannelType;
  readonly config: Record<string, unknown>;
  readonly events: string[];
  readonly status?: number;
}

/** 部分更新白名单(type 不可改——config 校验口径与渠道类型绑定) */
export interface ChannelPatchInput {
  readonly name?: string;
  readonly config?: Record<string, unknown>;
  readonly events?: string[];
  readonly status?: number;
}

export interface ClaimedNotification {
  readonly id: number;
  readonly event: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
  readonly claimToken: string;
  readonly deliveredChannelIds: number[];
}

export interface ClaimInput {
  readonly ownerId: string;
  readonly limit: number;
  readonly leaseMs: number;
  readonly maxAttempts: number;
}

export interface ClaimFencing {
  readonly id: number;
  readonly ownerId: string;
  readonly claimToken: string;
}

export interface FailClaimInput extends ClaimFencing {
  readonly maxAttempts: number;
  readonly error: string;
  /** 退避毫秒数(application 经 domain.backoffDelayMs 计算——公式单一真相在 domain) */
  readonly retryDelayMs: number;
}

export interface NotifyStore {
  /** 活跃渠道快照(status=0,按 id 升序)或全量 */
  listChannels(
    db: DbLike,
    filter: { readonly activeOnly: boolean },
  ): Promise<NotificationChannel[]>;
  findChannel(db: DbLike, channelId: number): Promise<NotificationChannel | null>;
  /** 重名由 PG 唯一索引兜底(23505);内存替身以同形错误模拟 */
  insertChannel(db: DbLike, input: ChannelInsertInput): Promise<NotificationChannel>;
  /** 0 行 = 不存在 */
  patchChannel(
    db: DbLike,
    input: { readonly channelId: number; readonly patch: ChannelPatchInput },
  ): Promise<NotificationChannel | null>;
  removeChannel(db: DbLike, channelId: number): Promise<boolean>;
  /** 入箱(dedupe_key 唯一冲突静默跳过——幂等) */
  insertOutboxEvent(
    db: DbLike,
    input: {
      readonly event: string;
      readonly payload: Record<string, unknown>;
      readonly dedupeKey: string;
    },
  ): Promise<void>;
  /** 原子批量认领(FOR UPDATE SKIP LOCKED——多副本不执行同一外部副作用) */
  claimPending(db: DbLike, input: ClaimInput): Promise<ClaimedNotification[]>;
  /** 外部副作用成功后持久化渠道进度;空数组恒真(无操作);租约过期/易主返回 false */
  recordDeliveredChannels(
    db: DbLike,
    input: ClaimFencing & { readonly channelIds: number[] },
  ): Promise<boolean>;
  /** 投递成功/无订阅渠道终态化(sent_at 置位);非当前有效 claim 返回 false */
  completeClaim(db: DbLike, input: ClaimFencing): Promise<boolean>;
  /** 投递失败:attempts+1;未达上限释放认领并设退避,达上限终态化 failed */
  failClaim(db: DbLike, input: FailClaimInput): Promise<boolean>;
}
