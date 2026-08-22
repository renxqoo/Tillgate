import type { GenerationTaskKind } from '../domain/generation';
import type { UsageReceipt } from '../domain/usage/receipt';

/**
 * 生成任务存储 port（消费方定义；生产实现为 postgres（generation_tasks 表，
 * control-plane/db 波次装配），单副本/测试用内存适配器）。
 * 轮询推进（running/终态/过期）归 worker 波次——本包只写入队与属主查询。
 */

export interface GenerationTaskRecord {
  taskId: string;
  requestId: string;
  userId: number;
  apiKeyId: number | null;
  /** 命中候选的映射 id（收据模板快照同源） */
  mappingId: number;
  channelId: number | null;
  kind: GenerationTaskKind;
  /** 上游任务号（task_execute = null；task_poll 同步完成 = null） */
  upstreamTaskId: string | null;
  status: 'queued';
  /** 提交参数快照（descriptor.snapshotParams 白名单产物） */
  params: Record<string, unknown>;
  /** 结算收据模板（除 units 外完整；轮询终态时补 units 快照结算） */
  receiptTemplate: UsageReceipt;
  /** 计量快照（提交时点按 pricingUnit 计量） */
  unitsSnapshot: number;
  /** 过期时刻（epoch ms；过期回收归 worker） */
  expiresAt: number;
}

export interface GenerationTaskView {
  taskId: string;
  kind: GenerationTaskKind;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'expired';
  /** 上游任务号（task_execute / 同步完成 = null） */
  upstreamTaskId: string | null;
  params: Record<string, unknown>;
  result: unknown;
  failReason: string | null;
  createdAt: number;
  expiresAt: number;
}

export interface GenerationTaskStore {
  insert(record: GenerationTaskRecord): Promise<void>;
  /** 属主隔离查询：非本人/不存在一律 null（404 语义） */
  findByOwner(userId: number, taskId: string): Promise<GenerationTaskView | null>;
}
