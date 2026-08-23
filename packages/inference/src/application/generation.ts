import { randomUUID } from 'node:crypto';
import { DefectError } from '@tokenlens/errors';
import { generationKindDescriptor } from '../domain/generation';
import type { GenerationTaskKind } from '../domain/generation';
import { InferenceErrors } from '../domain/errors';
import { buildCandidateChain } from '../domain/model/candidates';
import type { RequestAuth } from '../domain/model/types';
import { measurementOf } from '../domain/usage/measurement';
import { buildReceipt } from '../domain/usage/receipt';
import type { GenerationTaskStore, GenerationTaskView } from '../ports/generation';
import {
  dispatchFailure,
  runCandidateLoop,
  type AttemptOutcome,
  type ExecutionDeps,
  type PassthroughDelivered,
} from './failover';
import type { PreparedRequest } from './quote';

/** 生成任务提交输入（kind 词表 = domain/generation 注册表） */
export interface GenerationSubmitInput {
  requestId?: string;
  auth: RequestAuth;
  kind: GenerationTaskKind;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}

export type GenerationSubmitOutcome =
  | { ok: true; taskId: string; expiresAt: number }
  | PassthroughDelivered;

/** 命中事实（循环 respond 值）：上游任务号 + 命中候选与渠道（收据模板快照源） */
interface GenerationHit {
  upstreamTaskId: string | null;
  candidate: PreparedRequest['candidates'][number];
  channelId: number;
  channelName: string;
}

/**
 * 生成任务用例（v1 generation/submit.ts 迁移，限流剥离）：
 * 白名单 → 目录候选链 → authorize（TTL = 任务 TTL + 租约宽限）→ 候选×渠道循环
 * （task_poll 经上游提交任务号；task_execute 仅登记，worker 代执行）→ 收据模板
 * 持久化。持久化失败 → billing_receipt_unavailable 且**预留保留**（上游可能已受理，
 * 退款属 billing recover 语义——与 v1 同）。轮询推进归 worker 波次（MIGRATION 待办）。
 */
export function createGenerationUseCase(deps: ExecutionDeps & { tasks: GenerationTaskStore }) {
  return {
    async submit(input: GenerationSubmitInput): Promise<GenerationSubmitOutcome> {
      const requestId = input.requestId ?? randomUUID();
      // 分时段选价锚点 = 任务提交时刻（异步生成同 chat 口径：授权时快照）
      const submittedAt = new Date();
      const descriptor = generationKindDescriptor(input.kind);
      if (descriptor == null) {
        // 类型面已收窄；JS 调用方绕过类型时的装配缺陷
        throw new DefectError(
          `unknown generation kind: ${input.kind as string}`,
          'inference.generation.kind_unknown',
          { kind: input.kind },
        );
      }
      const externalModel = typeof input.body.model === 'string' ? input.body.model : '';
      if (input.auth.allowedModels != null && !input.auth.allowedModels.includes(externalModel)) {
        throw InferenceErrors.business('model_not_allowed', { model: externalModel });
      }
      const pricing = { userId: input.auth.userId, body: input.body, now: submittedAt };
      const mapping = await deps.catalog.findMapping(externalModel, pricing);
      if (mapping == null) {
        throw InferenceErrors.business('model_not_found', { model: externalModel });
      }
      const candidates = await buildCandidateChain(mapping, (m) =>
        deps.catalog.findMapping(m, pricing),
      );
      const prepared: PreparedRequest = {
        requestId,
        auth: input.auth,
        externalModel,
        body: input.body,
        upstreamBody: input.body,
        endpoint: input.kind,
        outputCap: 0,
        inputUpperBound: 0,
        inputEstimate: 0,
        candidates,
      };
      const authorizationTtlMs =
        deps.defaults.generation.taskTtlMs + deps.defaults.generation.leaseGraceMs;
      await deps.billing.authorize({
        requestId,
        userId: input.auth.userId,
        apiKeyId: input.auth.apiKeyId,
        appId: input.auth.appId,
        stream: false,
        candidates,
        inputTokenUpperBound: 0,
        maxOutputTokens: 0,
        authorizationTtlMs,
      });

      const hit = await runCandidateLoop<GenerationHit | PassthroughDelivered>(
        deps,
        prepared,
        requestId,
        Date.now(),
        input.signal,
        async (ctx): Promise<AttemptOutcome<GenerationHit | PassthroughDelivered>> => {
          if (descriptor.execution !== 'task_poll') {
            // task_execute：网关只登记（渠道已预留），worker 代执行
            return {
              kind: 'respond',
              value: {
                upstreamTaskId: null,
                candidate: ctx.candidate,
                channelId: ctx.channel.channelId,
                channelName: ctx.channel.channelName,
              },
            };
          }
          const result = await deps.upstream.submitTask(ctx.channel, input.kind, {
            requestId,
            externalModel,
            realModel: ctx.candidate.realModel,
            endpoint: input.kind,
            body: input.body,
            ...(input.signal != null ? { signal: input.signal } : {}),
            deadlineMs: deps.defaults.upstream.deadlineMs,
          });
          if (result.ok) {
            return {
              kind: 'respond',
              value: {
                upstreamTaskId: result.upstreamTaskId,
                candidate: ctx.candidate,
                channelId: ctx.channel.channelId,
                channelName: ctx.channel.channelName,
              },
            };
          }
          return dispatchFailure(deps, ctx, result.error);
        },
      );

      // 上游 4xx 透传（v1 提交路径同款）：客户端问题原码返回，不走收据持久化
      if ('passthrough' in hit) return hit;

      const taskId = randomUUID();
      const expiresAt = Date.now() + deps.defaults.generation.taskTtlMs;
      const receiptTemplate = buildReceipt({
        requestId,
        auth: input.auth,
        candidate: hit.candidate,
        externalModel,
        channelId: hit.channelId,
        channelKey: hit.channelName,
        durationMs: 0,
        body: input.body,
        usage: { estimated: true, inputTokens: 0, outputTokens: 0 },
      });
      const unitsSnapshot = measurementOf(hit.candidate.pricingUnit).unitsUpperBoundOf(input.body);
      try {
        await deps.tasks.insert({
          taskId,
          requestId,
          userId: input.auth.userId,
          apiKeyId: input.auth.apiKeyId,
          mappingId: hit.candidate.mappingId,
          channelId: hit.channelId,
          kind: input.kind,
          upstreamTaskId: hit.upstreamTaskId,
          status: 'queued',
          params: descriptor.snapshotParams(input.body),
          receiptTemplate,
          unitsSnapshot,
          expiresAt,
        });
      } catch (error) {
        // 上游可能已受理：预留保留交 recover 兜底（不退款——v1 语义）
        deps.onError?.(error, `generation task persist request=${requestId}`);
        throw InferenceErrors.business('billing_receipt_unavailable', { request_id: requestId });
      }
      return { ok: true, taskId, expiresAt };
    },

    async query(userId: number, taskId: string): Promise<GenerationTaskView> {
      const view = await deps.tasks.findByOwner(userId, taskId);
      if (view == null) throw InferenceErrors.business('task_not_found', { task_id: taskId });
      return view;
    },
  };
}
