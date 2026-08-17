import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Endpoint } from '@ai-gateway/ai';
import type { AuthEnv } from '../middleware/auth.js';
import { jsonBody } from '../lib/validation.js';
import { gatewayError } from '../lib/errors.js';
import type { RunInference } from '../services/pipeline/run.js';
import { audioSecondsFromFile } from '../services/modality-usage.js';

/**
 * 模态端点（JSON 族 + multipart 族）：
 *   POST /v1/images/generations   JSON：文生图（units=张）
 *   POST /v1/images/edits         multipart：图生图（units=张）
 *   POST /v1/audio/speech         JSON 入 / 二进制出（units=输入字符）
 *   POST /v1/audio/transcriptions multipart（units=音频秒）
 *   POST /v1/audio/translations   multipart（units=音频秒）
 *   POST /v1/rerank               JSON（units=次）
 *   POST /v1/moderations          JSON（units=次）
 *
 * multipart：网关解析（Hono parseBody）→ wrapper {model, n?, audioSeconds?, upstreamForm}
 * ——upstreamForm 为重组的上游 FormData（文件字节原样）；计量字段随 wrapper 进管线。
 * 文件类型白名单 + 单文件上界（16MB 全局 bodyLimit 兜底之外的显式约束）。
 */

const MODEL_FIELD_MAX = 64;

const modelField = z
  .string()
  .min(1)
  .max(MODEL_FIELD_MAX)
  .refine((v) => !v.includes('\0'), { message: 'model 含非法字符' });

const imagesSchema = z
  .object({
    model: modelField,
    prompt: z.string().min(1).max(32000),
    n: z.number().int().positive().max(16).optional(),
    size: z.string().max(32).optional(),
    responseupstreamFormat: z.enum(['url', 'b64_json']).optional(),
  })
  .passthrough();

const audioSpeechSchema = z
  .object({
    model: modelField,
    input: z.string().min(1).max(8192),
    voice: z.string().min(1).max(64),
    speed: z.number().min(0.25).max(4).optional(),
    responseupstreamFormat: z.string().max(32).optional(),
  })
  .passthrough();

const rerankSchema = z
  .object({
    model: modelField,
    query: z.string().min(1).max(32000),
    documents: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).min(1).max(2048),
  })
  .passthrough();

const moderationsSchema = z
  .object({
    model: modelField,
    input: z.union([z.string().max(65536), z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).max(2048)]),
  })
  .passthrough();

/** multipart 文件约束（类型白名单 + 大小上界） */
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const AUDIO_MIME = new Set(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/mp4', 'audio/x-m4a', 'audio/m4a']);
const MAX_FILE_BYTES = 16 * 1024 * 1024;

function rejectFile(message: string): never {
  throw gatewayError('invalid_request', { message });
}

function checkFile(file: File, allow: Set<string>): void {
  // 未知类型（octet-stream 常见于扩展名缺失）按扩展名兜底判定
  const mime = file.type || 'application/octet-stream';
  const name = file.name.toLowerCase();
  const extOk =
    (allow === IMAGE_MIME && /\.(png|jpe?g|webp)$/.test(name)) ||
    (allow === AUDIO_MIME && /\.(mp3|wav|webm|m4a|mp4)$/.test(name));
  if (!allow.has(mime) && !extOk) {
    rejectFile(`不支持的文件类型：${file.name}（${mime}）`);
  }
  if (file.size > MAX_FILE_BYTES) {
    rejectFile(`文件超过大小上限（16MB）：${file.name}`);
  }
}

/** multipart → 上游 FormData 重组 + 计量 wrapper */
async function buildMultipartWrapper(
  c: Context<AuthEnv>,
  opts: { modelRequired: boolean; fileField: string; allow: Set<string>; audio: boolean },
): Promise<Record<string, unknown>> {
  const form = await c.req.parseBody({ all: true });
  const wrapper: Record<string, unknown> = {};
  const upstream = new FormData();
  let model: string | null = null;
  let primaryFile: File | null = null;

  for (const [key, value] of Object.entries(form)) {
    if (value instanceof File) {
      checkFile(value, opts.allow);
      upstream.append(key, value, value.name);
      if (key === opts.fileField) primaryFile = value;
      continue;
    }
    // 字段：model/n 等进 wrapper（计量/路由用），全部原样带上游
    if (key === 'model') model = String(value);
    if (key === 'n') {
      const n = Number(value);
      if (Number.isInteger(n) && n > 0 && n <= 16) wrapper.n = n;
    }
    upstream.append(key, String(value));
  }

  if (opts.modelRequired && !model) {
    throw gatewayError('invalid_request', { message: '缺少 model 字段' });
  }
  if (!primaryFile) {
    throw gatewayError('invalid_request', { message: `缺少文件字段 ${opts.fileField}` });
  }
  if (model) wrapper.model = model;
  if (opts.audio) {
    wrapper.audioSeconds = await audioSecondsFromFile(primaryFile);
  }
  wrapper.upstreamForm = upstream;
  return wrapper;
}

/** 模态端点路径清单（app.ts 鉴权挂载单一真相） */
export const modalityEndpointPaths: readonly string[] = [
  '/v1/images/generations',
  '/v1/images/edits',
  '/v1/audio/speech',
  '/v1/audio/transcriptions',
  '/v1/audio/translations',
  '/v1/rerank',
  '/v1/moderations',
];

export function modalityRoutes(runInference: RunInference): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  const jsonEndpoints: Array<{
    path: string;
    kind: Extract<Endpoint, 'images' | 'audio_speech' | 'rerank' | 'moderations'>;
    schema: z.ZodType<Record<string, unknown>>;
  }> = [
    { path: '/v1/images/generations', kind: 'images', schema: imagesSchema },
    { path: '/v1/audio/speech', kind: 'audio_speech', schema: audioSpeechSchema },
    { path: '/v1/rerank', kind: 'rerank', schema: rerankSchema },
    { path: '/v1/moderations', kind: 'moderations', schema: moderationsSchema },
  ];

  for (const ep of jsonEndpoints) {
    app.post(ep.path, jsonBody(ep.schema), async (c) => {
      const body = c.req.valid('json') as Record<string, unknown>;
      return runInference(c, ep.kind, body);
    });
  }

  app.post('/v1/images/edits', async (c) => {
    const wrapper = await buildMultipartWrapper(c, {
      modelRequired: true,
      fileField: 'image',
      allow: IMAGE_MIME,
      audio: false,
    });
    return runInference(c, 'images_edits', wrapper);
  });

  app.post('/v1/audio/transcriptions', async (c) => {
    const wrapper = await buildMultipartWrapper(c, {
      modelRequired: true,
      fileField: 'file',
      allow: AUDIO_MIME,
      audio: true,
    });
    return runInference(c, 'audio_transcription', wrapper);
  });

  app.post('/v1/audio/translations', async (c) => {
    const wrapper = await buildMultipartWrapper(c, {
      modelRequired: true,
      fileField: 'file',
      allow: AUDIO_MIME,
      audio: true,
    });
    return runInference(c, 'audio_translation', wrapper);
  });

  return app;
}

