/**
 * 推理域契约（P4;v1 ops.ts generation-tasks zod 面平移）。
 * kind/status 词表单一真相 = inference 包 GENERATION_TASK_KINDS/STATUSES（不复制）。
 */
import { z } from 'zod';
import { GENERATION_TASK_KINDS, GENERATION_TASK_STATUSES } from '@tokenlens/inference';

export const tasksContracts = {
  /** 管理任务列表:kind/status 过滤 + limit/offset 运维翻页 */
  list: z.object({
    kind: z.enum(GENERATION_TASK_KINDS).optional(),
    status: z.enum(GENERATION_TASK_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  }),
} as const;
