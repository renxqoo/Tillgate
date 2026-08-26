/**
 * 异步生成任务契约（v1 routes/generation.ts 的 schema 段迁移）：
 * video（按秒计费；duration 4-15 缺省 6）/ music（同步阻塞型上游，worker 代执行）。
 */
import * as z from 'zod';

export const videoSchema = z
  .object({
    model: z.string().min(1, 'model must not be empty').max(200),
    prompt: z.string().min(1, 'prompt must not be empty').max(8_000),
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

export const musicSchema = z
  .object({
    model: z.string().min(1, 'model must not be empty').max(200),
    prompt: z.string().min(1, 'prompt must not be empty').max(4_000),
    lyrics: z.string().max(20_000).optional(),
  })
  .passthrough();

export type GenerationSchema = typeof videoSchema | typeof musicSchema;
