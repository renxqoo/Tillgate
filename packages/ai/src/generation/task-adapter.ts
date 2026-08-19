/**
 * 生成任务端口的生产适配器（service GenerationTaskPort 的 ai 实现——结构化类型
 * 对齐，不反向依赖 service）：提交/代执行走 ai.chat（endpoint=任务类型，复用
 * 重试/凭据面），响应经 parseGenerationResponse 归一；轮询走 queryGenerationTask，
 * url 需 files/retrieve 二次换取的协议在此补齐——编排层不见协议差异。
 * 渠道密钥解密由调用方注入（core.decrypt——本包零加密依赖）。
 */
import type { Ai, GenerationArtifact } from '../types';

/** 渠道连接信息（结构化兼容 repository TaskChannelRow——本包不依赖 repository） */
export interface TaskChannelDesc {
  channelName: string;
  apiKeyEnc: string;
  baseUrlOverride: string | null;
  providerName: string;
  providerBaseUrl: string;
  providerProtocol: string;
  /** 厂商档案引用（providers.vendor；null = 无档案纯透传） */
  providerVendor?: string | null;
}

export interface TaskPortErrorShape {
  code?: string;
  message?: string;
  deadCredential?: boolean;
}

export interface AiTaskAdapterDeps {
  ai: Ai;
  decrypt: (enc: string, key: string, oldKey?: string) => string;
  encryptionKey: string;
}

/** 上游错误形状兜底（无 body 无 error 的空响应 → invalid_response） */
const upstreamError = (
  error: { code?: string; message?: string; deadCredential?: boolean } | undefined,
): TaskPortErrorShape =>
  error ?? { code: 'invalid_response', message: 'upstream returned neither body nor error' };

export function createGenerationTaskAdapter(deps: AiTaskAdapterDeps) {
  const desc = (channel: TaskChannelDesc) => ({
    baseUrl: channel.baseUrlOverride ?? channel.providerBaseUrl,
    apiKey: deps.decrypt(channel.apiKeyEnc, deps.encryptionKey),
    protocol: channel.providerProtocol,
    ...(channel.providerVendor != null ? { vendor: channel.providerVendor } : {}),
  });

  return {
    /** task_poll 族：向上游提交任务 → 上游任务号 */
    async submitTask(channel: TaskChannelDesc, request: {
      requestId: string; realModel: string; externalModel: string; kind: string; body: Record<string, unknown>;
    }): Promise<
      { ok: true; upstreamTaskId: string } | { ok: false; error: TaskPortErrorShape }
    > {
      const channelDesc = desc(channel);
      const result = await deps.ai.chat({
        channel: channelDesc,
        request: request.body,
        ctx: {
          requestId: request.requestId,
          model: request.realModel,
          providerName: channel.providerName,
          endpoint: request.kind as 'video',
        },
      });
      if (result.status !== 'success') {
        return { ok: false, error: upstreamError(result.error) };
      }
      const parsed = deps.ai.parseGenerationResponse?.({
        channel: channelDesc,
        endpoint: request.kind as 'video' | 'music',
        body: result.body as Record<string, unknown>,
      });
      if (parsed?.kind === 'task_submitted') return { ok: true, upstreamTaskId: parsed.taskId };
      return {
        ok: false,
        error: parsed?.kind === 'error'
          ? { code: parsed.error.code, message: parsed.error.message, deadCredential: parsed.error.deadCredential }
          : { code: 'invalid_response', message: '上游未返回任务号' },
      };
    },

    /** task_execute 族：同步阻塞型上游调用（worker 代执行）→ 归一产物 */
    async executeTask(channel: TaskChannelDesc, request: {
      taskId: string; realModel: string; kind: string; params: Record<string, unknown>;
    }): Promise<
      { ok: true; artifact: Record<string, unknown> } | { ok: false; error: TaskPortErrorShape }
    > {
      const channelDesc = desc(channel);
      const result = await deps.ai.chat({
        channel: channelDesc,
        request: request.params,
        ctx: {
          requestId: request.taskId,
          model: request.realModel,
          providerName: channel.providerName,
          endpoint: request.kind as 'music',
          maxRetries: 2,
        },
      });
      if (result.status !== 'success') {
        return { ok: false, error: upstreamError(result.error) };
      }
      const parsed = deps.ai.parseGenerationResponse?.({
        channel: channelDesc,
        endpoint: request.kind as 'video' | 'music',
        body: result.body as Record<string, unknown>,
      });
      if (parsed?.kind === 'task_completed') {
        return { ok: true, artifact: parsed.artifact as Record<string, unknown> };
      }
      return {
        ok: false,
        error: parsed?.kind === 'error'
          ? { code: parsed.error.code, message: parsed.error.message }
          : { code: 'invalid_response', message: '上游未返回生成产物' },
      };
    },

    /** task_poll 族：查询上游任务三态（succeeded 的产物 URL 在此补齐） */
    async queryTask(channel: TaskChannelDesc, upstreamTaskId: string): Promise<
      | { ok: true; status: 'running' }
      | { ok: true; status: 'succeeded'; artifact: Record<string, unknown> }
      | { ok: true; status: 'failed'; reason: string }
      | { ok: false; error: TaskPortErrorShape }
    > {
      if (!deps.ai.queryGenerationTask) {
        return { ok: false, error: { code: 'task_ops_unavailable', message: '协议不支持任务查询' } };
      }
      const probe = await deps.ai.queryGenerationTask({ channel: desc(channel), taskId: upstreamTaskId });
      if (!probe.ok) return { ok: false, error: { code: probe.error.code, message: probe.error.message } };
      if (probe.status === 'running') return { ok: true, status: 'running' };
      if (probe.status === 'failed') return { ok: true, status: 'failed', reason: probe.reason ?? 'upstream task failed' };
      const artifact: GenerationArtifact = probe.artifact !== undefined ? { ...probe.artifact } : {};
      if (artifact.url === undefined && probe.fileId !== undefined && deps.ai.retrieveGenerationFile) {
        const file = await deps.ai.retrieveGenerationFile({ channel: desc(channel), fileId: probe.fileId });
        if (!file.ok) return { ok: false, error: { code: file.error.code, message: file.error.message } };
        artifact.url = file.downloadUrl;
      }
      return { ok: true, status: 'succeeded', artifact: artifact as Record<string, unknown> };
    },
  };
}
