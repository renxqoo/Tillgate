import { tableOrFallback } from '../errors/fallback';
import { UpstreamError } from '../errors/kinds';
import type { ErrorKind } from '../errors/kinds';
import { asRecord } from '../internal/util';
import type { ChannelDesc, Endpoint, GenerationArtifact, ParamRules,  Usage } from '../types';
import type { ParamAdjustment, ProtocolAdapter } from './protocol-adapter';
// 裸扩展名导入（包约定）：Next transpilePackages 不做 .js→.ts 映射，带后缀会让 admin 打包解析失败
import { createRestTaskOps } from './task-kit';

/**
 * MiniMax 适配器（protocol 'minimax'）：
 *   - 任务族（video/music）操作面 = task-kit 基座 + 本厂商配置（寻址/信封/字段映射）
 *   - chat 族 = OpenAI 兼容面（/v1/chat/completions、/v1/embeddings）
 * 事实源：MiniMax 开放平台 API + 本地 new-api 源码 relay/channel/task/hailuo
 * （请求构造/状态映射/错误码参照）。新增厂商 = 仿照本文件写一份配置 + 注册一行。
 */
export class MiniMaxAdapter implements ProtocolAdapter {
  readonly protocol: string = 'minimax';
  readonly supportedEndpoints: readonly Endpoint[] = ['chat', 'embeddings', 'video', 'music'];

  planRequest(
    channel: ChannelDesc,
    input: { endpoint: Endpoint; model: string; requestId: string; stream: boolean },
  ): { path: string; headers: Record<string, string> } {
    void input.stream;
    const path =
      input.endpoint === 'video'
        ? '/v1/video_generation'
        : input.endpoint === 'music'
          ? '/v1/music_generation'
          : input.endpoint === 'embeddings'
            ? '/v1/embeddings'
            : '/v1/chat/completions';
    return {
      path,
      headers: {
        authorization: `Bearer ${channel.apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': input.requestId,
      },
    };
  }

  /**
   * 请求体终态化（任务族为白名单重建，不做透传——canonical 字段 → MiniMax 形）：
   *   video: {model, prompt, duration(4-15, 默认 6), resolution(默认 720P，size 可覆写),
   *           first_frame_image ← image, last_frame_image}
   *   music:  {model, prompt, lyrics?, output_format:'url'}（产物取 URL，不内联 hex）
   * chat 族：model 重写 + 透传。
   */
  finalizeRequestBody(
    body: Record<string, unknown>,
    input: { endpoint: Endpoint; model: string; stream: boolean },
  ): Record<string, unknown> {
    if (input.endpoint === 'video') {
      const rawDuration = body.duration;
      const duration =
        typeof rawDuration === 'number' && Number.isFinite(rawDuration)
          ? Math.min(15, Math.max(4, Math.round(rawDuration)))
          : 6;
      const resolution = resolutionFromSize(body.size) ?? '720P';
      return {
        model: input.model,
        prompt: body.prompt ?? '',
        duration,
        resolution,
        ...(typeof body.image === 'string' ? { first_frame_image: body.image } : {}),
        ...(typeof body.last_frame_image === 'string' ? { last_frame_image: body.last_frame_image } : {}),
      };
    }
    if (input.endpoint === 'music') {
      return {
        model: input.model,
        prompt: body.prompt ?? '',
        ...(typeof body.lyrics === 'string' ? { lyrics: body.lyrics } : {}),
        output_format: 'url',
      };
    }
    return { ...body, model: input.model };
  }

  /** 任务族请求体由 zod 白名单校验后进入，无需规则抹平（透传底线） */
  normalizeRequest(
    req: unknown,
    _rules: ParamRules,
    _endpoint: Endpoint,
  ): { body: unknown; adjustments: ParamAdjustment[] } {
    void _rules;
    void _endpoint;
    return { body: req, adjustments: [] };
  }

  /** 任务族不按 token 计量（units 由描述符快照），chat 族提取规范 usage */
  extractUsage(res: unknown): Usage | null {
    const r = asRecord(res);
    const usage = asRecord(r?.usage);
    if (!usage) return null;
    return {
      inputTokens: positiveInt(usage.prompt_tokens),
      cachedInputTokens: 0,
      outputTokens: positiveInt(usage.completion_tokens),
      estimated: false,
      units: 0,
      raw: usage,
    };
  }

  /** 错误映射：base_resp 信封优先（200 也可能是错误），其余走通用分类矩阵 */
  mapError(status: number | undefined, body: unknown): UpstreamError {
    const fromEnvelope = minimaxEnvelopeError(body);
    if (fromEnvelope) return fromEnvelope;
    return tableOrFallback({ table: {}, status, body });
  }

  /** 连通性探测：GET 任务查询（无副作用；有效 Key → 200 JSON，无效 → 401） */
  probeRequests(channel: ChannelDesc): Array<{ path: string; headers: Record<string, string> }> {
    return [
      {
        path: '/v1/query/video_generation?task_id=00000000-0000-0000-0000-000000000000',
        headers: { authorization: `Bearer ${channel.apiKey}` },
      },
    ];
  }

  /** 任务操作面 = task-kit 基座 + MiniMax 配置（厂商知识全部收口在此配置） */
  tasks = createRestTaskOps({
    paths: {
      submit: '/v1/video_generation',
      query: (taskId) => `/v1/query/video_generation?task_id=${taskId}`,
      file: (fileId) => `/v1/files/retrieve?file_id=${fileId}`,
    },
    envelopeError: (body) => minimaxEnvelopeError(body),
    invalidBodyError: () =>
      new UpstreamError({
        kind: 'invalid_response',
        message: 'minimax response missing expected field',
      }),
    extractSubmissionTaskId: (body) =>
      typeof body.task_id === 'string' && body.task_id !== '' ? body.task_id : undefined,
    extractCompletedArtifact: (body): GenerationArtifact | undefined => {
      const audioUrl = asRecord(body.data)?.audio_url;
      return typeof audioUrl === 'string' && audioUrl !== '' ? { url: audioUrl } : undefined;
    },
    readStatus: (body) => {
      const width = maybeInt(body.video_width);
      const height = maybeInt(body.video_height);
      switch (body.status) {
        case 'Success':
          return {
            status: 'succeeded',
            fileId:
              typeof body.file_id === 'string' && body.file_id !== '' ? body.file_id : undefined,
            artifact: { ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) },
          };
        case 'Fail':
          return { status: 'failed', reason: 'upstream task failed' };
        // Preparing/Queueing/Processing/Unknown 及未知枚举 → running
        default:
          return { status: 'running' };
      }
    },
    extractFileUrl: (body) => {
      const url = asRecord(body.file)?.download_url;
      return typeof url === 'string' && url !== '' ? url : undefined;
    },
  });
}

/** base_resp 信封错误（HTTP 200 也可能是错误）：MiniMax 码 → kind（v1 码表迁移） */
function minimaxEnvelopeError(body: unknown): UpstreamError | null {
  const envelope = asRecord(asRecord(body)?.base_resp);
  if (!envelope) return null;
  const code = envelope.status_code;
  if (typeof code !== 'number' || code === 0) return null;
  const message =
    typeof envelope.status_msg === 'string' && envelope.status_msg !== ''
      ? envelope.status_msg
      : `minimax api error ${code}`;
  // 1004/2049 认证失败；1008 余额；1002/1026/1027/2013 参数与审查；429 限流；5xx 服务端
  const kind: ErrorKind =
    code === 1004 || code === 2049 ? 'invalid_api_key'
    : code === 1008 ? 'quota_exhausted'
    : code === 429 ? 'rate_limited'
    : code === 1002 || code === 1026 || code === 1027 || code === 2013 ? 'invalid_request'
    : 'upstream_error';
  return new UpstreamError({ kind, vendorCode: String(code), message });
}

/** 正整数归一（usage 计量） */
function positiveInt(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

/** 可选整数归一（尺寸等可选字段） */
function maybeInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined;
}

/** new-api hailuo 同款：尺寸串 → MiniMax resolution 档位（无法识别 → null 走默认） */
function resolutionFromSize(size: unknown): string | null {
  if (typeof size !== 'string' || size === '') return null;
  if (size.includes('1080')) return '1080P';
  if (size.includes('768')) return '768P';
  if (size.includes('720')) return '720P';
  if (size.includes('512')) return '512P';
  return null;
}
