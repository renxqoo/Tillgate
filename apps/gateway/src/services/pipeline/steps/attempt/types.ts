import type { Context } from 'hono';
import type { ChannelDesc } from '@ai-gateway/ai';
import type { ChannelCache } from '../../../routing/model-router.js';
import type { AuthContext, AuthEnv } from '../../../../middleware/auth.js';
import type {
  AttemptCtx,
  AttemptTraceContext,
  CandidateTarget,
  PipelineKind,
  RequestTraceContext,
} from '../../types.js';

/** attempt/ 族契约：单渠道尝试的入参（index/stream/non-stream/task-submit 共用） */

export interface AttemptArgs {
  c: Context<AuthEnv>;
  auth: AuthContext;
  requestId: string;
  body: Record<string, unknown>;
  externalModel: string;
  estimatedTotalTokens: number;
  kind: PipelineKind;
  target: CandidateTarget;
  channel: ChannelCache;
  ctx: AttemptCtx;
  stream: boolean;
  requestTrace: RequestTraceContext;
}

/** 传输模式函数的入参：attemptChannel 已解析好渠道描述符与链路上下文 */
export type TransportArgs = AttemptArgs & {
  channelDesc: ChannelDesc;
  trace: AttemptTraceContext;
};
