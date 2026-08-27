import { UpstreamError, type Ai, type AiEvent, type ChannelDesc } from '@tillgate/ai';
import type { GenerationTaskKind } from '../domain/generation';
import type { ChannelCandidate } from '../domain/model/types';
import type {
  UpstreamCallRequest,
  UpstreamPort,
  UpstreamStreamEvent,
  UpstreamStreamResult,
  UpstreamTaskExecuteResult,
  UpstreamTaskSubmitResult,
} from '../ports/upstream';

/**
 * UpstreamPort 生产适配器（封装 @tillgate/ai——渠道快照 + 凭据注入）：
 *   - ChannelDesc 组装：baseUrl（目录已解析 override）/ protocol / vendor，
 *     apiKey = 注入的 decrypt(apiKeyEnc)（明文不落盘、不出调用栈）；
 *   - 模型名替换：CallOptions.model = realModel（对外名 → 真实名在此完成，
 *     并回写 body/form——ai 的机制）；
 *   - 结果零包装：ChatResult/UpstreamError 直接透传（单一形态）；
 *   - 流事件映射：ai 事件面 → 端口三类事件（first_chunk/failed/success）。
 */
/** 调用选项映射（模块级纯函数——不捕获闭包） */
const callOpts = (req: UpstreamCallRequest) => ({
  requestId: req.requestId,
  model: req.realModel,
  endpoint: req.endpoint,
  deadlineMs: req.deadlineMs,
  ...(req.maxRetries != null ? { maxRetries: req.maxRetries } : {}),
  ...(req.signal != null ? { signal: req.signal } : {}),
});

/** ai 事件 → 端口三类事件的映射（模块级纯函数） */
const toStreamEvent = (e: AiEvent, cb: (event: UpstreamStreamEvent) => void): void => {
  switch (e.type) {
    case 'first_chunk': {
      cb({ type: 'first_chunk', atMs: e.atMs });
      break;
    }
    case 'failed': {
      cb({ type: 'failed', error: e.error });
      break;
    }
    case 'success': {
      cb({
        type: 'success',
        ...(e.usage !== undefined ? { usage: e.usage } : {}),
        ...(e.terminated !== undefined ? { terminated: e.terminated } : {}),
        ...(e.bytesRelayed !== undefined ? { bytesRelayed: e.bytesRelayed } : {}),
        ...(e.outputFeatures !== undefined ? { outputFeatures: e.outputFeatures } : {}),
        durationMs: e.durationMs,
      });
      break;
    }
    default: {
      break;
    } // attempt_start/stream_error/aborted 等不进端口面
  }
};

/** 渠道描述组装（模块级纯函数;凭据解密注入,明文不落盘、不出调用栈） */
function descOf(
  env: { ai: Ai; decrypt: (enc: string) => string },
  candidate: ChannelCandidate,
): ChannelDesc {
  return {
    baseUrl: candidate.baseUrl,
    apiKey: env.decrypt(candidate.apiKeyEnc),
    protocol: candidate.protocol,
    ...(candidate.vendor != null ? { vendor: candidate.vendor } : {}),
  };
}

/** 生成任务提交：协议响应解析 → 任务号（task_submitted 无号 = null） */
async function submitTaskViaAi(
  env: { ai: Ai; decrypt: (enc: string) => string },
  args: { candidate: ChannelCandidate; kind: GenerationTaskKind; request: UpstreamCallRequest },
): Promise<UpstreamTaskSubmitResult> {
  const desc = descOf(env, args.candidate);
  const result = await env.ai.chat(desc, args.request.body, {
    ...callOpts(args.request),
    endpoint: args.kind,
  });
  if (!result.ok) return { ok: false, error: result.error };
  const parsed = env.ai.tasks.parse(desc, args.kind, result.body);
  if (parsed.kind === 'error') return { ok: false, error: parsed.error };
  return {
    ok: true,
    upstreamTaskId: parsed.kind === 'task_submitted' ? parsed.taskId : null,
  };
}

/** 任务查询：succeeded 且 url 缺失、协议给 fileId（MiniMax files/retrieve 换取型）→ 适配器内二次换取补齐——编排层不见协议差异；换取失败 = 整体查询失败，轮询层按瞬时错误续租下轮重试 */
async function queryTaskViaAi(
  env: { ai: Ai; decrypt: (enc: string) => string },
  args: { candidate: ChannelCandidate; upstreamTaskId: string },
) {
  const desc = descOf(env, args.candidate);
  const probe = await env.ai.tasks.query(desc, args.upstreamTaskId);
  if (!probe.ok || probe.status !== 'succeeded') return probe;
  const artifact = { ...probe.artifact };
  if (artifact.url === undefined && probe.fileId !== undefined) {
    const file = await env.ai.tasks.file(desc, probe.fileId);
    if (!file.ok) return file;
    artifact.url = file.downloadUrl;
  }
  return artifact.url === probe.artifact?.url ? probe : { ...probe, artifact };
}

/** 同步执行：只接受 task_completed；返回任务号 = 协议形态错配（响亮失败） */
async function executeTaskViaAi(
  env: { ai: Ai; decrypt: (enc: string) => string },
  args: { candidate: ChannelCandidate; kind: GenerationTaskKind; request: UpstreamCallRequest },
): Promise<UpstreamTaskExecuteResult> {
  const desc = descOf(env, args.candidate);
  const result = await env.ai.chat(desc, args.request.body, {
    ...callOpts(args.request),
    endpoint: args.kind,
  });
  if (!result.ok) return { ok: false, error: result.error };
  const parsed = env.ai.tasks.parse(desc, args.kind, result.body);
  if (parsed.kind === 'error') return { ok: false, error: parsed.error };
  if (parsed.kind !== 'task_completed') {
    return {
      ok: false,
      error: new UpstreamError({
        kind: 'invalid_response',
        message: 'synchronous execution returned a task id',
      }),
    };
  }
  return { ok: true, artifact: parsed.artifact as Record<string, unknown> };
}

export function createUpstreamAi(env: { ai: Ai; decrypt: (enc: string) => string }): UpstreamPort {
  return {
    async chat(candidate, request) {
      return await env.ai.chat(descOf(env, candidate), request.body, callOpts(request));
    },

    async chatStream(candidate, request): Promise<UpstreamStreamResult> {
      const result = await env.ai.chatStream(
        descOf(env, candidate),
        request.body,
        callOpts(request),
      );
      return {
        stream: result.stream,
        onEvent: (cb) => {
          result.events.subscribe((e) => toStreamEvent(e, cb));
        },
      };
    },

    submitTask: (candidate, kind, request) => submitTaskViaAi(env, { candidate, kind, request }),

    queryTask: (candidate, upstreamTaskId) => queryTaskViaAi(env, { candidate, upstreamTaskId }),

    executeTask: (candidate, kind, request) => executeTaskViaAi(env, { candidate, kind, request }),
  };
}
