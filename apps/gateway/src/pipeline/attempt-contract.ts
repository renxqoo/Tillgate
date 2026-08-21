/**
 * 单次尝试的共享契约（run-chat 循环 ↔ attempt-nonstream / attempt-stream 的词汇表）：
 *   - UpstreamFailure：上游失败形态（端口错误 + 归一状态码；deadCredential 由 ai 包 classify 判定）
 *   - AttemptOutcome：结局编码——JS 无非局部 break/continue，fallback 决策以数据
 *     交还 run-chat 的候选×渠道循环翻译为 continue（换渠道）/ break（换候选）/ return
 *   - AttemptInput：流式/非流式共享的公共输入（分叉仅在执行形态与结算纪律）
 */
import type { Endpoint } from '@ai-gateway/ai';
import type { BillingQuoteCandidate } from '@ai-gateway/domain';
import { getTracer } from '@ai-gateway/core';
import type { RouteCandidateRow } from '@ai-gateway/repository';
import type { RunContext } from '@ai-gateway/service';
import type { AuthContext } from '../middleware/api-key.js';
import type { ChatCompletionBody, ChatResponse, PipelineDeps } from './run-chat.js';

export interface UpstreamFailure {
  code?: string;
  message?: string;
  status?: number;
  deadCredential?: boolean;
}

/** respond = 终局返回（成功或 4xx 透传）；switch_channel = 可换错误换下一渠道；
 *  next_candidate = 不可换错误换下一候选。 */
export type AttemptOutcome =
  | { kind: 'respond'; response: ChatResponse }
  | { kind: 'switch_channel'; error: UpstreamFailure }
  | { kind: 'next_candidate'; error: UpstreamFailure };

export interface AttemptInput {
  tracer: ReturnType<typeof getTracer>;
  /** 请求级起点（runChat 进入，鉴权中间件之后）：client_ttft 锚点，含限流/报价/授权/路由与换渠等待 */
  requestStartedAt: number;
  ctx: RunContext;
  requestId: string;
  auth: Pick<AuthContext, 'userId' | 'apiKeyId' | 'appId'>;
  body: ChatCompletionBody;
  /** 输出上限钳制后的转发体（预扣口径与上游实许输出对齐） */
  upstreamBody: Record<string, unknown>;
  endpoint: Endpoint;
  candidate: BillingQuoteCandidate;
  channel: RouteCandidateRow;
  channelAttempt: number;
  /** 字节保守上界（预扣敞口/TPM 口径——宁可多押，不作实扣） */
  estInput: number;
  /** BPE 输入估算（缺 usage 时实扣口径——与预扣同一估算器，向精确收敛） */
  bpeInput: number;
  /** 汇率快照预取（装配收据时才 await；失败已降级 null） */
  fxPromise: Promise<{ rate: string; fxRateId: number } | null>;
  deps: Pick<PipelineDeps, 'upstream' | 'billing' | 'config'>;
  noteError: (error: unknown, context: string) => void;
  /** 上游失败分派（runChat 闭包：死凭据拉黑 + 可换性判定 + 4xx 透传） */
  dispatchFailure: (
    channel: RouteCandidateRow,
    error: UpstreamFailure,
    status?: number,
  ) => Promise<AttemptOutcome>;
}
