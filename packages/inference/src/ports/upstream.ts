import type {
  ChatResult,
  Endpoint,
  TerminationReason,
  TextTokenFeatures,
  UpstreamError,
  Usage,
} from '@tokenlens/ai';
import type { GenerationTaskKind } from '../domain/generation';
import type { ChannelCandidate } from '../domain/model/types';

/**
 * 上游执行 port（v1 gateway pipeline/upstream-port.ts 迁移）：候选渠道连接信息进，
 * 归一化结果出。结果形态直接复用 ai 的 ChatResult / UpstreamError / Usage——
 * 端口不做同形包装（单一形态，铁律 8）；凭据解密与 ChannelDesc 组装在适配器。
 */

export interface UpstreamCallRequest {
  requestId: string;
  /** 请求对外模型名（错误上下文/日志关联） */
  externalModel: string;
  /** 真实上游模型名（ai CallOptions.model 在适配器注入） */
  realModel: string;
  endpoint: Endpoint;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  /** 单次尝试总预算（透传 ai CallOptions.deadlineMs） */
  deadlineMs: number;
}

/** 流式决定性/终态事件（端口面只保留路由与结算消费的三类；时序 = ai 事件契约） */
export type UpstreamStreamEvent =
  | { type: 'first_chunk'; atMs: number }
  | { type: 'failed'; error: UpstreamError }
  | {
      type: 'success';
      usage?: Usage;
      /** 流式正常结束 = undefined；中断结束 = 中断原因（中断计费路径依据） */
      terminated?: TerminationReason;
      bytesRelayed?: number;
      /** 输出内容特征四计数器（usage 缺失/取消时估算输出 token 的数据源） */
      outputFeatures?: TextTokenFeatures;
      durationMs: number;
    };

export interface UpstreamStreamResult {
  stream: ReadableStream<Uint8Array>;
  /** 订阅决定性/终态事件（多次订阅各自独立；终态对晚订阅重放——ai 事件面语义） */
  onEvent(cb: (event: UpstreamStreamEvent) => void): void;
}

/** 任务提交结果：upstreamTaskId null = 上游同步完成（罕见；状态推进归轮询波次） */
export type UpstreamTaskSubmitResult =
  | { ok: true; upstreamTaskId: string | null }
  | { ok: false; error: UpstreamError };

export interface UpstreamPort {
  chat(candidate: ChannelCandidate, request: UpstreamCallRequest): Promise<ChatResult>;
  chatStream(
    candidate: ChannelCandidate,
    request: UpstreamCallRequest,
  ): Promise<UpstreamStreamResult>;
  /** 任务族提交（video=task_poll；music=task_execute 不经此处——worker 代执行） */
  submitTask(
    candidate: ChannelCandidate,
    kind: GenerationTaskKind,
    request: UpstreamCallRequest,
  ): Promise<UpstreamTaskSubmitResult>;
}
