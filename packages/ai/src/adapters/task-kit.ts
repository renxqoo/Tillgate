import type {
  ChannelDesc,
  GenerationArtifact,
  GenerationParsedResponse,
  GenerationTaskProbeResult,
  UpstreamError,
} from '../types';
import type { ProtocolTaskOps } from './protocol-adapter';

/**
 * REST 任务适配器基座（任务型协议的通用骨架，组合式）：
 *
 *   寻址（paths/auth）+ 信封错误判定 + 提交/执行/状态/产物四段解析
 *   全部由配置注入——新厂商（可灵/即梦/Suno/…）= 一份配置对象 +
 *   createAi 注册一行，不复制类。厂商知识只允许存在于配置函数里。
 *
 * 产物统一归一形 GenerationArtifact；url 需二次换取（files/retrieve）的
 * 协议返回 fileId，编排层（create-ai/worker）按统一规则补齐 url。
 */

export interface RestTaskKitConfig {
  /** 寻址表（相对 baseUrl） */
  paths: {
    submit: string;
    query: (taskId: string) => string;
    file: (fileId: string) => string;
  };
  /** 认证头（默认 Bearer；签名协议自行覆写） */
  auth?: (channel: ChannelDesc) => Record<string, string>;
  /** 错误信封：HTTP 200 也可能是错误（如 MiniMax base_resp.status_code≠0） */
  envelopeError(body: unknown): UpstreamError | null;
  /** 响应缺关键字段的兜底错误 */
  invalidBodyError(): UpstreamError;
  /** 提交响应 → 上游任务号（缺字段 = undefined → invalidBody） */
  extractSubmissionTaskId(body: Record<string, unknown>): string | undefined;
  /** 同步执行响应（task_execute 族）→ 归一产物（缺字段 = undefined → invalidBody） */
  extractCompletedArtifact(body: Record<string, unknown>): GenerationArtifact | undefined;
  /** 查询响应 → 归一三态；succeeded 带产物（直返 url 型协议填 artifact.url，
   *  需 files/retrieve 换取型协议返回 fileId 由编排层补齐） */
  readStatus(body: Record<string, unknown>): {
    status: 'running' | 'succeeded' | 'failed';
    fileId?: string;
    artifact?: GenerationArtifact;
    reason?: string;
  };
  /** 产物取回响应 → 下载地址 */
  extractFileUrl(body: Record<string, unknown>): string | undefined;
}

function bearerAuth(channel: ChannelDesc): Record<string, string> {
  return { authorization: `Bearer ${channel.apiKey}` };
}

export function createRestTaskOps(cfg: RestTaskKitConfig): ProtocolTaskOps {
  const auth = cfg.auth ?? bearerAuth;
  return {
    parseResponse: (kind, body): GenerationParsedResponse => {
      const envelopeError = cfg.envelopeError(body);
      if (envelopeError) return { kind: 'error', error: envelopeError };
      const rec = body as Record<string, unknown> | null;
      if (!rec || typeof rec !== 'object') return { kind: 'error', error: cfg.invalidBodyError() };
      if (kind === 'video') {
        const taskId = cfg.extractSubmissionTaskId(rec);
        if (taskId === undefined || taskId === '')
          return { kind: 'error', error: cfg.invalidBodyError() };
        return { kind: 'task_submitted', taskId };
      }
      const artifact = cfg.extractCompletedArtifact(rec);
      if (artifact === undefined) return { kind: 'error', error: cfg.invalidBodyError() };
      return { kind: 'task_completed', artifact };
    },

    planTaskQuery: (channel, taskId) => ({
      path: cfg.paths.query(encodeURIComponent(taskId)),
      headers: auth(channel),
    }),

    parseTaskStatus: (body): GenerationTaskProbeResult => {
      const envelopeError = cfg.envelopeError(body);
      if (envelopeError) return { ok: false, error: envelopeError };
      const rec = body as Record<string, unknown> | null;
      if (!rec || typeof rec !== 'object') return { ok: false, error: cfg.invalidBodyError() };
      const read = cfg.readStatus(rec);
      if (read.status === 'succeeded') {
        return { ok: true, status: 'succeeded', fileId: read.fileId, artifact: read.artifact };
      }
      if (read.status === 'failed') {
        return { ok: true, status: 'failed', reason: read.reason ?? 'upstream task failed' };
      }
      return { ok: true, status: 'running' };
    },

    planFileRetrieve: (channel, fileId) => ({
      path: cfg.paths.file(encodeURIComponent(fileId)),
      headers: auth(channel),
    }),

    parseFileRetrieve: (body) => {
      const envelopeError = cfg.envelopeError(body);
      if (envelopeError) return { ok: false, error: envelopeError };
      const rec = body as Record<string, unknown> | null;
      const url = rec ? cfg.extractFileUrl(rec) : undefined;
      if (url === undefined || url === '') return { ok: false, error: cfg.invalidBodyError() };
      return { ok: true, downloadUrl: url };
    },
  };
}
