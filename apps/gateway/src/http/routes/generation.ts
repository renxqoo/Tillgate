/**
 * 异步生成任务路由（提交面 = inference.generation）：
 *   POST /v1/video/generations | /v1/music/generations —— 提交恒 201（new-api 形状）
 *   GET  /v1/videos/:id | /v1/musics/:id —— 归属查询（他人/异类/不存在一律 404）
 * id = 提交响应的 id（= billing requestId = generation_tasks 主键）。
 */
import { Hono, type Context } from 'hono';
import { HttpErrors } from '@tillgate/http';
import type { GenerationSubmitOutcome, Inference } from '@tillgate/inference';
import { conservativeInputTokenUpperBound } from '@tillgate/inference';
import { videoSchema, musicSchema } from '../contracts/generation';
import { requestSummaryOf } from '../middleware/request-log.js';
import type { AuthEnv } from '../middleware/api-key';
import { admitRequest, type RateLimitGate } from '../middleware/rate-limit';
import { GatewayErrors } from '../openai-error-face';
function invalidBody(json: (b: unknown, s: 400) => Response, issues: { message?: string }[]) {
  return json(
    {
      error: {
        code: GatewayErrors.code('invalid_body'),
        message: issues[0]?.message ?? 'invalid request body',
      },
    },
    400,
  );
}

/** 任务查询响应（new-api 兼容形状——video_url/audio_url 按类型呈现） */
function taskResponse(task: {
  taskId: string;
  kind: 'video' | 'music';
  status: string;
  failReason: string | null;
  createdAt: number;
  expiresAt: number;
  result: unknown;
}): Record<string, unknown> {
  const artifact = (task.result ?? {}) as { url?: string; width?: number; height?: number };
  const common = {
    id: task.taskId,
    object: task.kind,
    status: task.status,
    fail_reason: task.failReason,
    created_at: Math.floor(task.createdAt / 1_000),
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

/** 提交出站编码：透传错误（402/403/404/429）或 new-api 形状受理 201 */
function submitResponse(
  c: Context<AuthEnv>,
  outcome: { result: GenerationSubmitOutcome; kind: 'video' | 'music'; model: string },
): Response {
  const { result, kind, model } = outcome;
  if ('passthrough' in result) {
    return c.json(
      { error: { code: result.code, message: result.message ?? result.code } },
      result.status as 402 | 403 | 404 | 429,
    );
  }
  // new-api 形状（提交受理即 201）
  return c.json({ id: result.taskId, object: kind, model, status: 'queued' }, 201);
}

/** 提交处理工厂（schema 校验 → 准入 → generation.submit；失败释放 TPM 预占） */
function submitHandler(
  deps: { inference: Inference; rateLimit?: RateLimitGate },
  kind: 'video' | 'music',
  schema: typeof videoSchema | typeof musicSchema,
) {
  return async (c: Context<AuthEnv>) => {
    const raw = await c.req.json().catch(() => null);
    const genSummary = requestSummaryOf(c.req.method, raw);
    if (genSummary != null) c.set('requestLogSummary', genSummary);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return invalidBody(c.json.bind(c), parsed.error.issues);
    const auth = c.get('auth');
    const requestId = c.get('requestId');
    const admit = await admitRequest(deps.rateLimit, {
      requestId,
      auth,
      estimatedTokens: conservativeInputTokenUpperBound(parsed.data),
    });
    try {
      const result = await deps.inference.generation.submit({
        requestId,
        auth: {
          userId: auth.userId,
          apiKeyId: auth.apiKeyId,
          appId: auth.appId,
          allowedModels: auth.allowedModels,
        },
        kind,
        body: parsed.data,
        signal: c.req.raw.signal,
      });
      return submitResponse(c, {
        result,
        kind,
        model: (parsed.data as { model: string }).model,
      });
    } catch (error) {
      await admit.release();
      throw error;
    }
  };
}

export function generationRoutes(deps: {
  inference: Inference;
  rateLimit?: RateLimitGate;
}): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.post('/v1/video/generations', submitHandler(deps, 'video', videoSchema));
  app.post('/v1/music/generations', submitHandler(deps, 'music', musicSchema));

  /** 归属查询（他人任务或异类任务一律 404——不泄露存在性） */
  const query = (kind: 'video' | 'music') => async (c: Context<AuthEnv>) => {
    const auth = c.get('auth');
    const task = await deps.inference.generation.query(auth.userId, String(c.req.param('id')));
    if (!task || task.kind !== kind) {
      throw HttpErrors.business('not_found', { detail: 'Task not found' });
    }
    return c.json(taskResponse(task));
  };

  app.get('/v1/videos/:id', query('video'));
  app.get('/v1/musics/:id', query('music'));

  return app;
}
