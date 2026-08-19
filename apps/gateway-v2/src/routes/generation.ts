/**
 * 异步生成任务路由（video/music，api-contract §2.9 形状）：
 *   POST /v1/video/generations —— 提交（new-api 形状；duration 4-15s 缺省 6）
 *   POST /v1/music/generations —— 提交（同步阻塞型上游，worker 代执行）
 *   GET  /v1/videos/:id | /v1/musics/:id —— 任务查询（new-api 兼容形状）
 *
 * id = 提交响应的 id（= billing requestId = generation_tasks 主键）。
 * 安全：归属校验（他人任务一律 404，不暴露存在性）；产物 URL 由 worker 终态时
 * 从上游换取落 result（24h 时效由上游定义）。
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { createRepositories, type Db, type GenerationTaskRow } from '@ai-gateway/repository';
import type { RunContext } from '@ai-gateway/service';
import type { AuthEnv } from '../middleware/api-key.js';
import type { createSubmitGeneration } from '../generation/submit.js';

type SubmitGeneration = ReturnType<typeof createSubmitGeneration>;
type Auth = { ctx: RunContext; userId: number; apiKeyId: number; rpmLimit?: number | null; tpmLimit?: number | null };

const modelField = z.string().min(1).max(200);

const videoSchema = z
  .object({
    model: modelField,
    prompt: z.string().min(1, 'prompt 不能为空').max(8_000),
    /** 秒（4-15，缺省 6）——按秒计费的结算快照与预扣上界 */
    duration: z.number().int().min(4).max(15).optional(),
    /** 尺寸串（"1280x720"）→ 变体定价选择器可配 */
    size: z.string().max(32).optional(),
    /** 首帧图（URL / data URI） */
    image: z.string().max(1_000_000).optional(),
    /** 尾帧图（与 image 成对） */
    last_frame_image: z.string().max(1_000_000).optional(),
  })
  .passthrough();

const musicSchema = z
  .object({
    model: modelField,
    prompt: z.string().min(1, 'prompt 不能为空').max(4_000),
    lyrics: z.string().max(20_000).optional(),
  })
  .passthrough();

/** 终态时间戳（秒；未终态 null） */
const epochSeconds = (d: Date | null): number | null => (d ? Math.floor(d.getTime() / 1_000) : null);

/** 任务查询响应（new-api 兼容形状——video_url/audio_url 按类型呈现） */
function taskResponse(task: GenerationTaskRow): Record<string, unknown> {
  const artifact = (task.result ?? {}) as { url?: string; width?: number; height?: number };
  const common = {
    id: task.id,
    object: task.kind,
    status: task.status,
    fail_reason: task.failReason,
    created_at: epochSeconds(task.createdAt),
    finished_at: epochSeconds(task.finishedAt),
  };
  if (task.kind === 'video') {
    return {
      ...common,
      video_url: artifact.url ?? null,
      video_width: artifact.width ?? null,
      video_height: artifact.height ?? null,
    };
  }
  return { ...common, audio_url: artifact.url ?? null };
}

export function generationRoutes(deps: { db: Db; submit: SubmitGeneration }): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  const repos = createRepositories();

  const submit = (kind: 'video' | 'music', schema: z.ZodType<Record<string, unknown>>) =>
    async (c: { req: { json(): Promise<unknown> }; get: (k: 'auth') => Auth; json: (b: unknown, s?: 201) => Response }) => {
      const raw = await c.req.json().catch(() => null);
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        return c.json(
          { error: { code: 'invalid_body', message: parsed.error.issues[0]?.message ?? 'invalid request body' } },
          400 as never,
        );
      }
      const auth = c.get('auth');
      const result = await deps.submit(auth.ctx, { userId: auth.userId, apiKeyId: auth.apiKeyId, rpmLimit: auth.rpmLimit, tpmLimit: auth.tpmLimit }, kind, parsed.data);
      return c.json(result.body, 201);
    };

  app.post('/v1/video/generations', submit('video', videoSchema));
  app.post('/v1/music/generations', submit('music', musicSchema));

  /** 归属查询（他人任务或异类任务一律 404——不泄露存在性） */
  const query = (kind: 'video' | 'music') =>
    async (c: { req: { param: (k: string) => string }; get: (k: 'auth') => Auth; json: (b: unknown, s?: 200 | 404) => Response }) => {
      const auth = c.get('auth');
      const task = await repos.generationTask.findByOwner({ ...auth.ctx, db: deps.db }, {
        id: c.req.param('id'),
        userId: auth.userId,
      });
      if (!task || task.kind !== kind) {
        return c.json({ error: { code: 'not_found', message: '任务不存在' } }, 404);
      }
      return c.json(taskResponse(task), 200);
    };

  app.get('/v1/videos/:id', query('video'));
  app.get('/v1/musics/:id', query('music'));

  return app;
}
