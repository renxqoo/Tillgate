/**
 * 模态 multipart 族路由：
 *   POST /v1/images/edits         multipart（image 文件 + prompt；units=张）
 *   POST /v1/audio/transcriptions multipart（audio 文件；units=音频秒）
 *   POST /v1/audio/translations   multipart（audio 文件；units=音频秒）
 * multipart 解析在网关：Hono parseBody → wrapper {model, n?, audioSeconds?, upstreamForm}
 * ——upstreamForm 为重组的上游 FormData（文件字节原样）；计量字段随 wrapper 进管线。
 * 文件类型白名单 + 单文件上界（与 bodyLimit 取 min——bodyLimit 先拦 413）。
 */
import { Hono, type Context } from 'hono';
import type { Inference } from '@tillgate/inference';
import { estimateAudioDurationSeconds } from '@tillgate/inference';
import type { AuthEnv } from '../middleware/api-key';
import { toInferenceInput } from './inference-input';
import { admitRequest, type RateLimitGate } from '../middleware/rate-limit';
import { GatewayErrors } from '../openai-error-face';

const DEFAULT_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const DEFAULT_AUDIO_MIME = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
  'audio/mp4',
  'audio/x-m4a',
  'audio/m4a',
]);
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;

/** multipart 上传约束（装配注入；缺省取模块默认） */
export interface ModalityLimits {
  imageMime?: ReadonlySet<string>;
  audioMime?: ReadonlySet<string>;
  maxFileBytes?: number;
  bodyLimitBytes?: number;
}

function badRequest(c: Context, message: string) {
  return c.json({ error: { code: GatewayErrors.code('invalid_body'), message } }, 400);
}

/** 文件约束束（MIME 白名单 + 音频族标志 + 单文件上界） */
interface FileConstraint {
  allow: ReadonlySet<string>;
  audio: boolean;
  maxFileBytes: number;
}

function checkFile(file: File, constraint: FileConstraint): void {
  const mime = file.type || 'application/octet-stream';
  // MIME 白名单外的常见扩展名回退（浏览器无 type 时仍可用）
  const extOk = constraint.audio
    ? /\.(mp3|wav|webm|m4a|mp4)$/.test(file.name)
    : /\.(png|jpe?g|webp)$/.test(file.name);
  if (!constraint.allow.has(mime) && !extOk) {
    throw new Error(`Unsupported file type: ${file.name} (${mime})`);
  }
  if (file.size > constraint.maxFileBytes) {
    throw new Error(
      `File exceeds size limit (${Math.floor(constraint.maxFileBytes / 1024 / 1024)}MB): ${file.name}`,
    );
  }
}

interface MultipartWrapper {
  model: string;
  n?: number;
  audioSeconds?: number;
  upstreamForm: FormData;
}

async function buildMultipartWrapper(
  request: Request,
  opts: { fileField: string } & FileConstraint,
): Promise<MultipartWrapper> {
  const form = await request.formData();
  const wrapper: Record<string, unknown> = {};
  const upstream = new FormData();
  let model: string | null = null;
  let primaryFile: File | null = null;

  for (const [key, value] of form.entries()) {
    if (value instanceof File) {
      checkFile(value, opts);
      upstream.append(key, value, value.name);
      if (key === opts.fileField) primaryFile = value;
      continue;
    }
    if (key === 'model') model = String(value);
    if (key === 'n') {
      const n = Number(value);
      if (Number.isInteger(n) && n > 0 && n <= 16) wrapper.n = n;
    }
    upstream.append(key, String(value));
  }

  if (!model) throw new Error('Missing model field');
  if (!primaryFile) throw new Error(`Missing file field ${opts.fileField}`);
  wrapper.model = model;
  if (opts.audio) {
    try {
      const buf = new Uint8Array(await primaryFile.arrayBuffer());
      wrapper.audioSeconds = estimateAudioDurationSeconds(buf);
    } catch {
      wrapper.audioSeconds = 1; // 字节解析失败兜底（防上游异常文件阻塞路由）
    }
  }
  wrapper.upstreamForm = upstream;
  return wrapper as unknown as MultipartWrapper;
}

/** multipart 族出站编码（恒非流式三态：错误透传 / 原始字节 / JSON body） */
function encodeMultipartResult(
  c: Context<AuthEnv>,
  result: Awaited<ReturnType<Inference['chat']>>,
  requestId: string | undefined,
): Response {
  // multipart 族出站恒 JSON（无 codec 无流式）
  if ('passthrough' in result && result.passthrough) {
    return c.json(
      { error: { code: result.code, message: result.message ?? result.code } },
      result.status as 200 | 400 | 402 | 403 | 404,
    );
  }
  if ('rawBody' in result && result.rawBody instanceof Uint8Array) {
    return new Response(result.rawBody, {
      status: 200,
      headers: {
        'content-type': result.rawContentType ?? 'application/octet-stream',
        ...(requestId != null ? { 'x-request-id': requestId } : {}),
      },
    });
  }
  return c.json(
    'body' in result ? result.body : null,
    ('status' in result ? result.status : 200) as 200,
  );
}

/** 三路由共用的处理工厂（multipart 解析 → 准入 → chat → 三态出站编码） */
function multipartRoute(
  deps: { inference: Inference; rateLimit?: RateLimitGate },
  maxFileBytes: number,
  opts: {
    fileField: string;
    allow: ReadonlySet<string>;
    audio: boolean;
    kind: 'images_edits' | 'audio_transcription' | 'audio_translation';
  },
): (c: Context<AuthEnv>) => Promise<Response> {
  return async (c) => {
    let wrapper: MultipartWrapper;
    try {
      wrapper = await buildMultipartWrapper(c.req.raw, { ...opts, maxFileBytes });
    } catch (error) {
      return badRequest(c, (error as Error).message);
    }
    const auth = c.get('auth');
    const requestId = c.get('requestId');
    const body = wrapper as unknown as Record<string, unknown>;
    // multipart 族恒非流式
    const admit = await admitRequest(deps.rateLimit, {
      requestId,
      auth,
      estimatedTokens: JSON.stringify(body).length,
    });
    try {
      const result = await deps.inference.chat(
        toInferenceInput({ requestId, auth, body, endpoint: opts.kind }),
      );
      return encodeMultipartResult(c, result, requestId);
    } catch (error) {
      await admit.release();
      throw error;
    }
  };
}

export function modalityMultipartRoutes(
  deps: { inference: Inference; rateLimit?: RateLimitGate },
  limits: ModalityLimits = {},
): Hono<AuthEnv> {
  const imageMime = limits.imageMime ?? DEFAULT_IMAGE_MIME;
  const audioMime = limits.audioMime ?? DEFAULT_AUDIO_MIME;
  // 单文件上界取「本路由声明与全局 bodyLimit」的较小值（bodyLimit 先拦 413）
  const maxFileBytes = Math.min(
    limits.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    limits.bodyLimitBytes ?? 10 * 1024 * 1024,
  );

  return new Hono<AuthEnv>()
    .post(
      '/v1/images/edits',
      multipartRoute(deps, maxFileBytes, {
        fileField: 'image',
        allow: imageMime,
        audio: false,
        kind: 'images_edits',
      }),
    )
    .post(
      '/v1/audio/transcriptions',
      multipartRoute(deps, maxFileBytes, {
        fileField: 'file',
        allow: audioMime,
        audio: true,
        kind: 'audio_transcription',
      }),
    )
    .post(
      '/v1/audio/translations',
      multipartRoute(deps, maxFileBytes, {
        fileField: 'file',
        allow: audioMime,
        audio: true,
        kind: 'audio_translation',
      }),
    );
}
