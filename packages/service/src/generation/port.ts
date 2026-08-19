/**
 * 生成任务上游端口（service ↔ 上游传输的接缝，纯类型）：
 * 业务编排（service）只依赖本端口——渠道连接信息进，归一结果出。
 * 生产适配器（packages/ai 的任务操作面 + apiKeyEnc 解密）在各 app 装配
 * （gateway 提交 / worker 轮询共用同一契约）；测试注入 stub 验证资金编排。
 */
import type { TaskChannelRow } from '@ai-gateway/repository';

export interface TaskSubmitRequest {
  requestId: string;
  realModel: string;
  externalModel: string;
  /** 任务类型（domain 词表键——适配器据此选上游端点） */
  kind: string;
  /** 快照后的请求体（task_poll 族提交上游） */
  body: Record<string, unknown>;
}

export interface TaskExecuteRequest {
  /** generation_tasks.id（代执行的上游 ctx 锚点） */
  taskId: string;
  realModel: string;
  kind: string;
  /** 快照参数即代执行请求体 */
  params: Record<string, unknown>;
}

export interface TaskPortError {
  code?: string;
  message?: string;
  deadCredential?: boolean;
}

export type TaskSubmitResult =
  | { ok: true; upstreamTaskId: string }
  | { ok: false; error: TaskPortError };

export type TaskExecuteResult =
  | { ok: true; artifact: Record<string, unknown> }
  | { ok: false; error: TaskPortError };

/**
 * 上游任务三态查询（归一）：succeeded 的产物 URL 由适配器补齐
 * （需 files/retrieve 二次换取的协议在适配器内完成——编排层不见协议差异）。
 */
export type TaskQueryResult =
  | { ok: true; status: 'running' }
  | { ok: true; status: 'succeeded'; artifact: Record<string, unknown> }
  | { ok: true; status: 'failed'; reason: string }
  | { ok: false; error: TaskPortError };

export interface GenerationTaskPort {
  /** task_poll 族：向上游提交任务 → 上游任务号 */
  submitTask(channel: TaskChannelRow, request: TaskSubmitRequest): Promise<TaskSubmitResult>;
  /** task_execute 族：同步阻塞型上游调用（worker 代执行）→ 归一产物 */
  executeTask(channel: TaskChannelRow, request: TaskExecuteRequest): Promise<TaskExecuteResult>;
  /** task_poll 族：查询上游任务终态 */
  queryTask(channel: TaskChannelRow, upstreamTaskId: string): Promise<TaskQueryResult>;
}
