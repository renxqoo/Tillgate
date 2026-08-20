/**
 * runChat 用例（管线编排核心——app 层，零业务规则；流式/非流式双分支）：
 *
 *   报价（G2）→ 资金预扣（service.authorize，requestId=请求 ID 幂等）
 *   → 候选模型 × 各自渠道调度序（G3）双层循环：敞口预留（reserveChannel）→ 上游（端口）
 *     非流式：可换错误 → 下一渠道/模型；4xx → 直接失败
 *     流式：  first_chunk 前失败同非流式换渠；上线后不换（流内错误已转错误帧）
 *   → 成功：收据（命中候选价格快照 + 可信/估算 usage）→ signal(succeeded)
 *     全败：signal(failed) 三路归还 → 502 信封
 *   死凭据 → 渠道落库 status=4 后继续
 *
 * Redis 状态共享 / OTel = G4d 运营加固。
 *
 * 单次尝试执行层在 ./attempt-nonstream.ts 与 ./attempt-stream.ts（共享契约
 * ./attempt-contract.ts；结算重试 ./settle-retry.ts）。
 */
import { estimateInputTokens, type Endpoint } from '@ai-gateway/ai';
import { estimateMaxCost } from '@ai-gateway/domain';
import type { FundingReservationPolicy } from '@ai-gateway/domain';
import { getTracer, SpanStatusCode, withAsyncSpan } from '@ai-gateway/core';
import { createRepositories } from '@ai-gateway/repository';
import type { Db, Repositories, RouteCandidateRow } from '@ai-gateway/repository';
import type { BillingDomain, RunContext } from '@ai-gateway/service';
import { AppError } from '../http/error-map.js';
import type { AuthContext } from '../middleware/api-key.js';
import { createBuildQuote } from '../quote/build-quote.js';
import { createResolveChannels } from '../routing/resolve-channels.js';
import { isChannelSwitchable } from '../routing/switchable.js';
import type { AttemptInput, AttemptOutcome, UpstreamFailure } from './attempt-contract.js';
import { attemptNonStream } from './attempt-nonstream.js';
import { attemptStream } from './attempt-stream.js';
import { clampForwardedOutputLimit, conservativeInputTokenUpperBound, maxOutputTokensFor, type OutputCapConfig } from './output-cap.js';
import { admitKey, reserveModelDims, tryChannel, type RateLimitGate } from '../rate-limit/gate.js';
import { sanitizeUpstreamDetail } from '../http/sanitize.js';
import type { UpstreamPort } from './upstream-port.js';

type BuildQuote = ReturnType<typeof createBuildQuote>;
type ResolveChannels = ReturnType<typeof createResolveChannels>;

export interface RunChatConfig {
  reservationLimit: string;
  reservationPolicy?: FundingReservationPolicy;
  authorizationTtlMs: number;
  output: OutputCapConfig;
}

/** 端点分类（显式 endpoint 的纯函数——曾用 body 魔法字段 + 形状推断双轨，
 *  现单一真相：路由边界声明的端点；chat/embeddings 之外的一切都属模态族）。 */
function kindOf(endpoint: Endpoint): 'chat' | 'embeddings' | 'modality' {
  if (endpoint === 'chat' || endpoint === 'embeddings') return endpoint;
  return 'modality';
}

export interface ChatCompletionBody {
  model: string;
  messages: unknown[];
  stream?: boolean;
  [key: string]: unknown;
}

export interface PipelineDeps {
  db: Db;
  billing: BillingDomain;
  buildQuote: BuildQuote;
  resolveChannels: ResolveChannels;
  upstream: UpstreamPort;
  config: RunChatConfig;
  repos?: Repositories;
  /** 限流闸（Redis 装配注入；未装配 = 单副本开发形态全放行） */
  rateLimit?: RateLimitGate;
  /** 死凭据落库失败只记日志不阻塞请求 */
  onError?: (error: unknown, context: string) => void;
}

export type ChatResponse =
  | { status: number; body: Record<string, unknown> }
  | { status: 200; stream: ReadableStream<Uint8Array>; contentType: 'text/event-stream' }
  /** 二进制成功（音频等）：字节体 + 上游 content-type（v1 对位——JSON 信封会毁掉字节流） */
  | { status: 200; rawBody: Uint8Array; rawContentType: string };

export function createRunChat(deps: PipelineDeps) {
  const repos = deps.repos ?? createRepositories();
  const noteError = deps.onError ?? ((error, context) => console.error(`[pipeline] ${context}:`, error));
  return async function runChat(
    ctx: RunContext,
    auth: Pick<AuthContext, 'userId' | 'apiKeyId' | 'appId' | 'rpmLimit' | 'tpmLimit' | 'userRpmLimit' | 'userTpmLimit' | 'allowedModels'>,
    body: ChatCompletionBody,
    endpoint: Endpoint,
  ): Promise<ChatResponse> {
    const tracer = getTracer('gateway.pipeline');
    const requestId = ctx.requestId;
    // 模型白名单（App JWT scope.models）：预扣前拒绝——受限凭证调未授权模型的越权计费
    if (auth.allowedModels != null && !auth.allowedModels.includes(body.model)) {
      throw new AppError(403, 'model_not_allowed', `模型 ${body.model} 不在该凭证的授权范围内`);
    }
    // 双口径输入估算：bpeInput 供缺 usage 的实扣（向精确收敛）；字节保守上界
    // estInput 只作预扣敞口/TPM（宁可多押）——上界入实扣会让故障/缺 usage 流的
    // input 多收 3-6×，出现「残缺交付贵于完整交付」的反直觉账单
    const bpeInput = estimateInputTokens(body, { model: body.model });
    const estInput = conservativeInputTokenUpperBound(body as Record<string, unknown>, bpeInput);
  // 请求时点汇率快照（60s 进程缓存）：预取不阻塞授权关键路径（CI 慢机上多一次
  // DB 往返会挤占流租约续租时序）——装配收据时才 await；查询失败降级 null
  const fxPromise = repos.fx.current({ ...ctx, db: deps.db }).catch(() => null);
    const kind = kindOf(endpoint);
    const outputCap = maxOutputTokensFor(kind === 'modality' ? 'embeddings' : kind, body, deps.config.output);
    const stream = body.stream === true;
    const estimatedTokens = estInput + outputCap;
    // 预扣口径与上游实许输出对齐：超上限钳制，未声明则注入硬上限。
    const upstreamBody = clampForwardedOutputLimit(body as Record<string, unknown>, outputCap);

    // 准入并罚（v1 五维语义的 v2 形态）：凭证维 + 用户维各自生效——
    // 高限额 Key 不得越过用户帽；用户维无条件在列（App-JWT 的 scope 限额
    // 只约束 app 维——用户自建 App 声明大 scope 不得绕过管理端用户帽）；
    // 未装配限流闸时全放行（单副本开发形态）
    if (deps.rateLimit) {
      const credentialDimension =
        auth.apiKeyId != null ? `key:${auth.apiKeyId}` : auth.appId != null ? `app:${auth.appId}` : `pg:${auth.userId}`;
      await withAsyncSpan(tracer, 'rate_limit.admit', {
        'request.id': requestId,
        'user.id': auth.userId,
        'rate_limit.credential_dim': credentialDimension,
        'tokens.estimate': estimatedTokens,
      }, () =>
        admitKey(deps.rateLimit!, {
          requestId,
          estimatedTokens,
          dims: [
            {
              dimension: credentialDimension,
              rpmLimit: auth.rpmLimit ?? null,
              tpmLimit: auth.tpmLimit ?? null,
            },
            {
              dimension: `user:${auth.userId}`,
              rpmLimit: auth.userRpmLimit ?? null,
              tpmLimit: auth.userTpmLimit ?? null,
            },
          ],
        }),
      );
    }

    // 报价/免费额度可能拒绝（404/403/429）——TPM 已预占，失败路径同样归还
    // （其余罕见异常路径由 600s 预占 TTL 自回收，同 v1 语义）
    let quote;
    try {
      quote = await withAsyncSpan(tracer, 'quote.build', {
        'request.id': requestId,
        'user.id': auth.userId,
        'ai.model': body.model,
      }, async (span) => {
        const q = await deps.buildQuote(ctx, {
          model: body.model,
          userId: auth.userId,
          inputTokenUpperBound: estInput,
          maxOutputTokens: outputCap,
          body: body as Record<string, unknown>,
        });
        span.setAttributes({ 'quote.candidates': q.candidates.length, 'quote.free': q.explicitlyFree });
        return q;
      });
    } catch (error) {
      if (deps.rateLimit) await deps.rateLimit.limiter.releaseTpm(requestId).catch(() => {});
      throw error;
    }
    if (quote.candidates.length === 0) {
      // TPM 已预占（admitKey）——404 拒绝同样归还，防 600s 预占泄漏
      if (deps.rateLimit) await deps.rateLimit.limiter.releaseTpm(requestId).catch(() => {});
      throw new AppError(404, 'model_not_found', '模型不存在或已下架');
    }
    // 模型维 TPM 预占（主 + fallback 候选 mappingId 一并占住——v1 reserveFallbackDims 语义）
    if (deps.rateLimit) {
      await withAsyncSpan(tracer, 'rate_limit.reserve_model', {
        'request.id': requestId,
        'ai.model': body.model,
        'tokens.estimate': estimatedTokens,
      }, () =>
        reserveModelDims(deps.rateLimit!, {
          requestId,
          mappingIds: quote.candidates.map((candidate) => candidate.mappingId),
          tpmLimit: auth.userTpmLimit ?? auth.tpmLimit ?? null,
          estimatedTokens,
        }),
      );
    }

    // 授权可能拒绝（402/限额/配置）
    let authorization;
    try {
      authorization = await withAsyncSpan(tracer, 'billing.authorize', {
        'request.id': requestId,
        'user.id': auth.userId,
        'ai.model': body.model,
        'billing.stream': stream,
      }, () =>
        deps.billing.authorize(ctx, {
          requestId,
          userId: auth.userId,
          apiKeyId: auth.apiKeyId,
          // App-JWT 凭证的订阅绑定（resolveSourceAndLimits 按它取订阅——漏传=App 全走 PAYG）
          appId: auth.appId ?? null,
          stream,
          quote,
          reservationLimit: deps.config.reservationLimit,
          ...(deps.config.reservationPolicy != null
            ? { reservationPolicy: deps.config.reservationPolicy }
            : {}),
          authorizationTtlMs: deps.config.authorizationTtlMs,
          // 请求根 span 的 traceparent 落列——worker 结算按它挂回同一 trace
          traceParent: ctx.traceParent,
        }),
      );
    } catch (error) {
      if (deps.rateLimit) await deps.rateLimit.limiter.releaseTpm(requestId).catch(() => {});
      throw error;
    }
    void authorization;

    let leaseStarted = false;
    let lastError: UpstreamFailure | undefined;
    /** 上游 4xx 透传（OpenAI 兼容语义：客户端问题原码返回——不吞成 502、不空耗 fallback）。
     *  透传≠免收尾：TPM 预占归还 + request.failed 三路释放（4xx = 上游确定未计费） */
    const passthrough4xx = async (error: {
      code?: string; message?: string; status?: number;
    }): Promise<ChatResponse> =>
      withAsyncSpan(tracer, 'billing.passthrough_4xx', {
        'request.id': requestId,
        'error.code': error.code ?? 'upstream_client_error',
        'http.status_code': error.status ?? 0,
      }, async (span) => {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.code ?? 'upstream_client_error' });
        if (deps.rateLimit) await deps.rateLimit.limiter.releaseTpm(requestId).catch(() => {});
        await deps.billing.signal(ctx, {
          type: 'request.failed',
          requestId,
          reason: (error.code ?? 'upstream_client_error').slice(0, 64),
        });
        return {
          status: error.status != null && error.status >= 400 && error.status < 500 ? error.status : 502,
          body: {
            error: {
              code: error.code ?? 'upstream_error',
              message: sanitizeUpstreamDetail(error.message, {
                externalModel: body.model,
                realModels: quote.candidates.map((c) => c.realModel),
              }),
            },
          },
        };
      });
    const startChannel = async (channelId: number, amount: string, channelKey: string): Promise<boolean> => {
      const reservation = await deps.billing.reserveChannel(ctx, { requestId, channelId, amount });
      if (!reservation.allowed) {
        lastError = { code: 'channel_budget_exhausted' };
        await withAsyncSpan(tracer, 'channel.skip', {
          'request.id': requestId,
          'channel.key': channelKey,
          'skip.reason': 'budget_exhausted',
        }, async () => {});
        return false;
      }
      if (!leaseStarted) {
        await deps.billing.signal(ctx, {
          type: 'upstream.started',
          requestId,
          leaseOwner: 'gateway',
          leaseMs: deps.config.authorizationTtlMs,
        });
        leaseStarted = true;
      }
      return true;
    };
    /** 全败收尾：TPM 预占归还（无上游执行的失败）→ request.failed 三路归还 → 502
     *  （message 脱敏：真实模型名等内部细节进日志不进响应） */
    const releaseAndFail = async (): Promise<never> =>
      withAsyncSpan(tracer, 'billing.release_and_fail', {
        'request.id': requestId,
        'user.id': auth.userId,
        'error.code': lastError?.code ?? 'no_available_channel',
      }, async () => {
        if (deps.rateLimit) await deps.rateLimit.limiter.releaseTpm(requestId).catch(() => {});
        // v1 语义：从未得到上游响应、纯渠道面拒绝（限流/预算耗尽）= 503 no_available_channel。
        // rate_limited = 上游 429 归一码（如 OpenRouter 免费池共享限流）——同属渠道面
        // 竭尽而非上游故障，漏列会误报 502 upstream_failed 误导排障
        const channelExhausted =
          lastError == null ||
          lastError.code === 'channel_budget_exhausted' ||
          lastError.code === 'rate_limit_exceeded' ||
          lastError.code === 'rate_limited';
        await deps.billing.signal(ctx, {
          type: 'request.failed',
          requestId,
          reason: (channelExhausted ? 'no_available_channel' : (lastError?.code ?? 'no_available_channel')).slice(0, 64),
        });
        if (channelExhausted) {
          throw new AppError(503, 'no_available_channel', '模型所有渠道均不可用，请稍后重试');
        }
        throw new AppError(
          502,
          'upstream_failed',
          sanitizeUpstreamDetail(lastError?.message, {
            externalModel: body.model,
            realModels: quote.candidates.map((candidate) => candidate.realModel),
          }),
        );
      });
    const markDead = async (channelId: number): Promise<void> => {
      try {
        await deps.db.transaction((tx) => repos.channel.markDeadCredential({ ...ctx, db: tx }, channelId));
      } catch (error) {
        noteError(error, `mark dead credential channel=${channelId}`);
      }
    };
    /** 上游失败分派（非流式 / 流式 first_chunk 前共用——原先两段逐字重复的孪生逻辑）：
     *  死凭据拉黑 → 可换性判定 → 4xx 透传终局 / 换候选。控制流编码为 AttemptOutcome
     *  交还循环体翻译（attempt 函数内无法 break/continue 外层循环）。 */
    const dispatchFailure = async (
      channel: RouteCandidateRow,
      error: UpstreamFailure,
      status?: number,
    ): Promise<AttemptOutcome> => {
      if (error.deadCredential) await markDead(channel.channelId);
      if (isChannelSwitchable(error.code)) return { kind: 'switch_channel', error };
      // 4xx 客户端错误：退出全部候选（fallback 救不了参数错误——白耗上游调用与预占）
      if ((status ?? 0) >= 400 && (status ?? 0) < 500) {
        return { kind: 'respond', response: await passthrough4xx({ ...error, status }) };
      }
      return { kind: 'next_candidate', error };
    };

    for (const candidate of quote.candidates) {
      const channels = await withAsyncSpan(tracer, 'routing.resolve', {
        'request.id': requestId,
        'ai.model': candidate.realModel,
      }, async (span) => {
        const list = await deps.resolveChannels(ctx, candidate.realModel);
        span.setAttribute('routing.channels', list.length);
        return list;
      });
      const upstreamEstimate = estimateMaxCost({
        estimatedInputTokens: estInput,
        maxOutputTokens: outputCap,
        inputPrice: candidate.inputPrice,
        cacheInputPrice: candidate.cacheInputPrice,
        cacheWritePrice: candidate.cacheWritePrice,
        outputPrice: candidate.outputPrice,
        unitPrice: candidate.unitPrice ?? '0',
        unitUpperBound: candidate.unitUpperBound ?? 0,
        coefficient: '1',
      }).toString();

      let channelAttempt = 0;
      for (const channel of channels) {
        channelAttempt += 1;
        // 渠道维尝试前判定（超限视同可换渠：continue 换下一渠道）
        if (deps.rateLimit && !(await tryChannel(deps.rateLimit, {
          requestId,
          channelId: channel.channelId,
          rpmLimit: channel.rpmLimit,
          tpmLimit: channel.tpmLimit,
          estimatedTokens,
        }))) {
          lastError = { code: 'rate_limit_exceeded', message: '渠道限流' };
          await withAsyncSpan(tracer, 'channel.skip', {
            'request.id': requestId,
            'channel.key': channel.channelName,
            'channel.attempt': channelAttempt,
            'skip.reason': 'rate_limited',
          }, async () => {});
          continue;
        }
        if (!(await startChannel(channel.channelId, upstreamEstimate, channel.channelName))) continue;

        // 单次尝试（流式/非流式仅执行形态与结算纪律分叉，准入与 fallback 决策共用）：
        // 结局编码为 AttemptOutcome，由本循环翻译回 continue（换渠道）/ break（换候选）
        const attempt: AttemptInput = {
          tracer, ctx, requestId, auth, body, upstreamBody, endpoint,
          candidate, channel, channelAttempt, estInput, bpeInput, fxPromise,
          deps, noteError, dispatchFailure,
        };
        const outcome = stream ? await attemptStream(attempt) : await attemptNonStream(attempt);
        if (outcome.kind !== 'respond') lastError = outcome.error;
        if (outcome.kind === 'switch_channel') continue;
        if (outcome.kind === 'next_candidate') break;
        return outcome.response;
      }
    }

    return releaseAndFail();
  };
}
