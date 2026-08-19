/**
 * 模态 multipart 族路由：
 *   POST /v1/images/edits         multipart（image 文件 + prompt；units=张）
 *   POST /v1/audio/transcriptions multipart（audio 文件；units=音频秒）
 *   POST /v1/audio/translations   multipart（audio 文件；units=音频秒）
 *
 * multipart 解析在网关：Hono parseBody → wrapper {model, n?, audioSeconds?, upstreamForm}
 * ——upstreamForm 为重组的上游 FormData（文件字节原样）；计量字段随 wrapper 进管线。
 * 文件类型白名单 + 单文件上界（16MB——bodyLimit 之外的显式约束）。
 * 音频秒数从文件字节推（modality-usage 单一真相）。
 */
import { Hono } from 'hono';
import type { createRunChat } from '../pipeline/run-chat.js';
import type { ChatCompletionBody } from '../pipeline/run-chat.js';
import { estimateAudioDurationSeconds } from '@ai-gateway/ai';
import type { AuthEnv } from '../middleware/api-key.js';

type RunChat = ReturnType<typeof createRunChat>;

const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const AUDIO_MIME = new Set(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/mp4', 'audio/x-m4a', 'audio/m4a']);
// 单文件上界取「全局 bodyLimit 与本路由声明」的较小值（bodyLimit 先拦 413——
// 声明 16MB 而全局 10MiB 时，本检查永远不可达即是死代码）
const MAX_FILE_BYTES = Math.min(16 * 1024 * 1024, Number(process.env.GATEWAY_BODY_LIMIT_BYTES ?? 10 * 1024 * 1024));

function checkFile(file: File, allow: Set<string>): void {
  const mime = file.type || 'application/octet-stream';
  if (!allow.has(mime) && !(
    (allow === IMAGE_MIME && /\.(png|jpe?g|webp)$/.test(file.name)) ||
    (allow === AUDIO_MIME && /\.(mp3|wav|webm|m4a|mp4)$/.test(file.name))
  )) {
    throw new Error(`不支持的文件类型：${file.name}（${mime}）`);
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`文件超过大小上限（16MB）：${file.name}`);
  }
}

interface MultipartWrapper {
  model: string;
  n?: number;
  audioSeconds?: number;
  upstreamForm: FormData;
  inferenceKind: string;
}

async function buildMultipartWrapper(
  request: Request,
  opts: { fileField: string; allow: Set<string>; audio: boolean; kind: string },
): Promise<MultipartWrapper> {
  const form = await request.formData();
  const wrapper: Record<string, unknown> = {};
  const upstream = new FormData();
  let model: string | null = null;
  let primaryFile: File | null = null;

  for (const [key, value] of form.entries()) {
    if (value instanceof File) {
      checkFile(value, opts.allow);
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

  if (!model) throw new Error('缺少 model 字段');
  if (!primaryFile) throw new Error(`缺少文件字段 ${opts.fileField}`);
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
  wrapper.inferenceKind = opts.kind;
  return wrapper as unknown as MultipartWrapper;
}

export function modalityMultipartRoutes(runChat: RunChat): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  const handle = (opts: { fileField: string; allow: Set<string>; audio: boolean; kind: string }) =>
    async (c: { req: { raw: Request }; get: (k: 'auth') => { ctx: Parameters<RunChat>[0]; userId: number; apiKeyId: number; appId?: number | null; allowedModels?: string[] | null; rpmLimit?: number | null; tpmLimit?: number | null; userRpmLimit?: number | null; userTpmLimit?: number | null }; json: (b: unknown, s?: never) => Response }) => {
      // 只有 multipart 解析（缺字段/类型白名单/超限）是 400 invalid_body；
      // 管线错误（402 余额/404 模型/500 配置）必须走统一错误翻译，不得吞成 400。
      let wrapper: MultipartWrapper;
      try {
        wrapper = await buildMultipartWrapper(c.req.raw, opts);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'multipart 解析失败';
        return c.json({ error: { code: 'invalid_body', message } }, 400 as never);
      }
      const auth = c.get('auth');
      const result = await runChat(
        auth.ctx,
        { userId: auth.userId, apiKeyId: auth.apiKeyId, appId: auth.appId ?? null, allowedModels: auth.allowedModels ?? null, rpmLimit: auth.rpmLimit ?? null, tpmLimit: auth.tpmLimit ?? null, userRpmLimit: auth.userRpmLimit ?? null, userTpmLimit: auth.userTpmLimit ?? null },
        wrapper as unknown as ChatCompletionBody,
      );
      if ('stream' in result) return new Response(result.stream);
      if ('rawBody' in result) {
        return new Response(result.rawBody, {
          status: 200,
          headers: { 'content-type': result.rawContentType },
        });
      }
      return c.json(result.body, result.status as never);
    };

  app.post('/v1/images/edits', handle({ fileField: 'image', allow: IMAGE_MIME, audio: false, kind: 'images_edits' }));
  app.post('/v1/audio/transcriptions', handle({ fileField: 'file', allow: AUDIO_MIME, audio: true, kind: 'audio_transcription' }));
  app.post('/v1/audio/translations', handle({ fileField: 'file', allow: AUDIO_MIME, audio: true, kind: 'audio_translation' }));

  return app;
}
