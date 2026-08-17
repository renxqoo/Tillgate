import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { generationTasks } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import type { GenerationArtifact } from '@ai-gateway/ai';
import { gatewayError } from '../lib/errors.js';
import type { AuthEnv } from '../middleware/auth.js';

/**
 * 异步生成任务查询（video/music，api-contract §2.9）：
 *   GET /v1/videos/:id —— new-api 兼容形状（status/video_url/尺寸/失败原因）
 *   GET /v1/musics/:id —— 同构（audio_url）
 *
 * id = 提交响应的 id（= billing requestId = generation_tasks 主键）。
 * 安全：任务归属校验（他人任务一律 404，不暴露存在性）；产物 URL 由 worker
 * 在终态时从上游换取并落 result（24h 时效，与上游一致）。
 */
export function generationTaskRoutes(db: Db): Hono<AuthEnv> {
  const lookup = async (id: string, kind: string, userId: number) => {
    const task = await db.query.generationTasks.findFirst({
      where: eq(generationTasks.id, id),
    });
    // 归属不符按不存在处理（不泄露他人任务存在性）
    if (!task || task.userId !== userId) {
      throw gatewayError('not_found', { message: '任务不存在' });
    }
    if (task.kind !== kind) {
      throw gatewayError('not_found', { message: `该任务不是 ${kind} 任务` });
    }
    return task;
  };

  return new Hono<AuthEnv>()
    .get('/v1/videos/:id', async (c) => {
      const task = await lookup(c.req.param('id'), 'video', c.var.auth.userId);
      const artifact = (task.result ?? {}) as GenerationArtifact;
      return c.json({
        id: task.id,
        object: 'video',
        status: task.status,
        video_url: artifact.url ?? null,
        video_width: artifact.width ?? null,
        video_height: artifact.height ?? null,
        fail_reason: task.failReason,
        created_at: Math.floor(task.createdAt.getTime() / 1000),
        finished_at: task.finishedAt ? Math.floor(task.finishedAt.getTime() / 1000) : null,
      });
    })
    .get('/v1/musics/:id', async (c) => {
      const task = await lookup(c.req.param('id'), 'music', c.var.auth.userId);
      const artifact = (task.result ?? {}) as GenerationArtifact;
      return c.json({
        id: task.id,
        object: 'music',
        status: task.status,
        audio_url: artifact.url ?? null,
        fail_reason: task.failReason,
        created_at: Math.floor(task.createdAt.getTime() / 1000),
        finished_at: task.finishedAt ? Math.floor(task.finishedAt.getTime() / 1000) : null,
      });
    });
}
