/**
 * 生成任务类型词表（v1 domain/generation/kinds.ts 迁移，语义不变）：
 *
 * 每个任务类型一条纯数据描述——
 *   execution     执行模型：task_poll（网关提交上游任务号，worker 轮询终态）/
 *                 task_execute（同步阻塞型上游，网关只登记，worker 代执行）
 *   snapshotParams 提交参数快照白名单（落任务存储；task_execute 族的快照即
 *                 worker 代执行的请求体）——透传全量落库有体积与注入面风险。
 *
 * 计量（units）不在此重复：单一真相在 usage/measurement.ts（按映射 pricingUnit
 * 从请求体推——video 按 duration 钳制秒、music 按次恒 1）。
 * 新任务类型 = 注册一个描述符，零侵入提交/轮询/结算。
 */

export type GenerationTaskKind = 'video' | 'music';

export interface GenerationKindDescriptor {
  readonly kind: GenerationTaskKind;
  readonly execution: 'task_poll' | 'task_execute';
  /** 提交参数快照白名单（显式字段） */
  snapshotParams(body: Record<string, unknown>): Record<string, unknown>;
}

export const GENERATION_KINDS: Readonly<Record<GenerationTaskKind, GenerationKindDescriptor>> = {
  video: {
    kind: 'video',
    execution: 'task_poll',
    snapshotParams: (body) => ({
      model: body.model,
      prompt: body.prompt ?? '',
      ...(typeof body.duration === 'number' ? { duration: body.duration } : {}),
      ...(typeof body.size === 'string' ? { size: body.size } : {}),
      ...(typeof body.image === 'string' ? { image: body.image } : {}),
      ...(typeof body.last_frame_image === 'string'
        ? { last_frame_image: body.last_frame_image }
        : {}),
    }),
  },
  music: {
    kind: 'music',
    execution: 'task_execute',
    snapshotParams: (body) => ({
      model: body.model,
      prompt: body.prompt ?? '',
      ...(typeof body.lyrics === 'string' ? { lyrics: body.lyrics } : {}),
    }),
  },
};

export function generationKindDescriptor(kind: string): GenerationKindDescriptor | undefined {
  return (GENERATION_KINDS as Record<string, GenerationKindDescriptor | undefined>)[kind];
}

/** 词表守卫（注册表驱动，无字面量）：任务存储行的 kind 列收窄回词表类型 */
export function isGenerationTaskKind(kind: string): kind is GenerationTaskKind {
  return generationKindDescriptor(kind) !== undefined;
}
