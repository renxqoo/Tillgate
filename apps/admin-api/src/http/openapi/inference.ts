/**
 * 推理域 OpenAPI registry（routes/ops-tasks.ts 契约面）。
 * 查询 schema 引用 contracts/inference.ts（kind/status 词表单一真相在 inference 包）;
 * 响应 wire 形状按 presenters/ops.ts toTaskWireRow（epoch ms → ISO 字符串）。
 */
import * as z from 'zod';
import { tasksContracts } from '../contracts/inference';
import type { OpenApiEndpoint } from './shared';

/** 生成任务管理行（limit/offset 运维翻页;已结算任务实扣金额页内批量回填） */
const generationTaskRowSchema = z.object({
  id: z.string().describe('任务 id（task.id ≠ 计费锚）'),
  requestId: z.string().describe('账单锚（billing_requests.request_id;实扣金额回填的关联键）'),
  kind: z.string().describe('任务种类（词表在 inference 包 GENERATION_TASK_KINDS）'),
  status: z.string().describe('任务状态（词表在 inference 包 GENERATION_TASK_STATUSES）'),
  userId: z.number(),
  channelId: z.number(),
  upstreamTaskId: z.string().nullable(),
  failReason: z.string().nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
  billingStatus: z
    .string()
    .nullable()
    .describe('账单状态(billing_requests.status;null = 无账单行)'),
  settledAmount: z
    .string()
    .nullable()
    .describe('已结算任务的实扣金额（未结算/无账单行 = null;页内批量回填）'),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  expiresAt: z.string(),
});

export const inferenceEndpoints: readonly OpenApiEndpoint[] = [
  {
    method: 'get',
    path: '/v1/generation-tasks',
    tag: 'generation-tasks',
    summary: '生成任务管理列表（kind/status 过滤 + limit/offset 运维翻页）',
    query: tasksContracts.list,
    response: {
      schema: z.object({ items: z.array(generationTaskRowSchema), total: z.number() }),
    },
    errors: [400, 401],
  },
];
