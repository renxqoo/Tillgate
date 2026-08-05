import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { modelMappings, modelChannels, channels, providers } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import { type Ai, type ChannelDesc, type Usage, estimateTokens, extractRequestChars } from '@ai-gateway/ai';

import { calcHold, estimateMaxCost } from '@ai-gateway/money';
import { decrypt } from '../lib/crypto.js';
import { BillingService } from '../lib/billing.js';
import { RateLimiter } from '../lib/rate-limit.js';
import { MeterProducer } from '../lib/meter.js';
import { recordRequest, recordChannelFailure } from '../lib/metrics.js';
import { markChannelDeadCredential, isDeadCredentialError } from '../lib/dead-credential-persist.js';
import { errorResponse, type AuthEnv } from '../middleware/auth.js';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { z } from 'zod';
import { jsonBody } from '../lib/validation.js';
import { syncSettle } from '../lib/sync-settle.js';
import { isModelAllowed } from '../lib/model-scope.js';
import { env, logger } from '../index.js';

/** 归一化上游 usage（OpenAI/DeepSeek/MiniMax 多格式 → 标准 Usage） */
function normalizeUpstreamUsage(raw: Record<string, unknown>): Usage {
  const promptTokens = Number(raw.prompt_tokens ?? raw.input_tokens ?? 0);
  const completionTokens = Number(raw.completion_tokens ?? raw.output_tokens ?? 0);
  const cached = Number(
    (raw.prompt_tokens_details as { cached_tokens?: number })?.cached_tokens ??
    raw.prompt_cache_hit_tokens ?? 0,
  );
  return {
    inputTokens: promptTokens,
    cachedInputTokens: cached,
    outputTokens: completionTokens,
    estimated: false,
    raw,
  };
}

/** chat/completions 请求 schema（必需字段校验，未知参数透传） */
const chatSchema = z
  .object({
    model: z.string().min(1, 'model 不能为空'),
    messages: z.array(z.unknown()).min(1, 'messages 不能为空'),
    stream: z.boolean().optional(),
    max_tokens: z.number().int().positive().optional(),
  })
  .passthrough();

/** 默认输出上限估算（请求未带 max_tokens 时） */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
/** 全局 RPM 上限（防整站被打；tech-stack §5：2000 RPM/实例） */
const GLOBAL_RPM = 2000;

/**
 * POST /v1/chat/completions — 对话补全（OpenAI 格式，含 SSE 流式）
 *
 * 链路：鉴权 → 限流(RPM) → 预扣(hold) → 模型路由 → 渠道选择 → ai 包调用 → 释放 hold → SSE/JSON
 * 结算（写 usage_logs + transactions）留 worker 异步队列。
 */
export function chatCompletionsRoutes(db: Db, ai: Ai, billing: BillingService, rateLimiter: RateLimiter, meter: MeterProducer): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  const upstreamTracer = trace.getTracer('gateway.upstream');

  app.post('/', jsonBody(chatSchema), async (c) => {
    const auth = c.var.auth;
    const requestId = c.var.requestId;
    const body = c.req.valid('json') as Record<string, unknown>;
    const model = body.model as string;
    const stream = body.stream === true;

    // ---- JWT scope.models 越权校验（S3）----
    // JWT 签发的 scope.models 白名单：不在白名单内的模型直接 403（防越权计费）
    if (!isModelAllowed(auth.allowedModels, model)) {
      return errorResponse(c, 403, 'model_not_allowed', `模型「${model}」不在当前凭证的可用范围内`);
    }

    // ---- 限流（RPM，requirements 4.6）----
    // 维度：全局 → 用户 → Key（静态 Key）或 App（JWT scope.rpm）。任一超限即 429。
    const rlDims: Array<{ dimension: string; max: number }> = [
      { dimension: 'global', max: GLOBAL_RPM },
      { dimension: `user:${auth.userId}`, max: auth.userRpmLimit ?? env.DEFAULT_USER_RPM },
    ];
    if (auth.apiKeyId !== null && auth.keyRpmLimit !== null) {
      rlDims.push({ dimension: `key:${auth.apiKeyId}`, max: auth.keyRpmLimit });
    }
    if (auth.appId !== null && auth.appRpmLimit !== null) {
      rlDims.push({ dimension: `app:${auth.appId}`, max: auth.appRpmLimit });
    }
    const rlResult = await rateLimiter.checkAll(rlDims, requestId);
    if (!rlResult.allowed) {
      c.header('retry-after', String(rlResult.retryAfterSec ?? 1));
      return errorResponse(
        c,
        429,
        'rate_limit_exceeded',
        `请求过于频繁（${rlResult.dimension} 维度超限）`,
        `请 ${rlResult.retryAfterSec} 秒后重试`,
      );
    }

    // ---- TPM 限流（token/分钟，requirements 4.6）----
    // 预占 = 输入 token（输出不可预知，不计入当前窗口，由 worker 回填）
    const estimatedInputTokensForTpm = estimateTokens(extractRequestChars(body), 3.5);
    const tpmDims: Array<{ dimension: string; estimatedTokens: number; max: number }> = [
      { dimension: `user:${auth.userId}`, estimatedTokens: estimatedInputTokensForTpm, max: auth.userTpmLimit ?? env.DEFAULT_USER_TPM },
    ];
    if (auth.apiKeyId !== null && auth.keyTpmLimit !== null) {
      tpmDims.push({ dimension: `key:${auth.apiKeyId}`, estimatedTokens: estimatedInputTokensForTpm, max: auth.keyTpmLimit });
    }
    if (auth.appId !== null && auth.appTpmLimit !== null) {
      tpmDims.push({ dimension: `app:${auth.appId}`, estimatedTokens: estimatedInputTokensForTpm, max: auth.appTpmLimit });
    }
    const tpmResult = await rateLimiter.checkTpmAll(tpmDims);
    if (!tpmResult.allowed) {
      c.header('retry-after', String(tpmResult.retryAfterSec ?? 1));
      return errorResponse(
        c,
        429,
        'rate_limit_exceeded',
        `Token 用量超限（${tpmResult.dimension} 维度 TPM）`,
        `请 ${tpmResult.retryAfterSec} 秒后重试`,
      );
    }

    // 模型路由：externalName → model_mappings（上架）→ 渠道列表
    const mapping = await db.query.modelMappings.findFirst({
      where: and(eq(modelMappings.externalName, model), eq(modelMappings.status, 0)),
    });
    if (!mapping) {
      return errorResponse(c, 404, 'model_not_found', `模型「${model}」不存在或已下架`);
    }

    /** 构造计量 job 并入队（fire-and-forget，幂等 jobId=requestId）。
     *  资损防线：入队失败（Redis 挂）→ 同步降级结算（DB 兜底），绝不漏扣。 */
    const enqueueMeter = async (
      usage: Usage,
      durationMs: number,
      channelId: number | null,
      realModel: string,
      streamAborted: boolean,
    ): Promise<void> => {
      const jobData = {
        requestId,
        userId: auth.userId,
        apiKeyId: auth.apiKeyId,
        appId: auth.appId,
        credentialType: auth.credentialType,
        externalModel: model,
        realModel,
        channelId,
        usage: {
          inputTokens: usage.inputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          outputTokens: usage.outputTokens,
          estimated: usage.estimated,
        },
        inputPrice: mapping.inputPrice,
        outputPrice: mapping.outputPrice,
        cacheInputPrice: mapping.cacheInputPrice,
        coefficient: auth.coefficientMilli / 1000,
        coefficientMilli: auth.coefficientMilli,
        durationMs,
        stream,
        streamAborted,
        holdAmount,
        mappingId: mapping.id,
      };
      const result = await meter.enqueue(jobData);
      if (!result.ok) {
        // 入队失败（Redis 挂）→ 同步降级结算：DB 原子扣费（幂等，Redis 恢复后 worker 跳过重复）
        logger.warn({ requestId, err: result.error?.message }, 'meter enqueue failed, falling back to sync settle');
        try {
          await syncSettle(db, jobData);
        } catch (e) {
          // DB 也挂了 → 记错误日志（运维介入；此时全站不可用）
          logger.error({ requestId, err: e instanceof Error ? e.message : String(e) }, 'sync settle also failed (DB unavailable) — revenue loss');
        }
      }
    };

    // ---- 模型级限流（model_mappings.rpmLimit/tpmLimit，保护上游配额）----
    if (mapping.rpmLimit) {
      const mRpm = await rateLimiter.check(`model:${mapping.id}`, mapping.rpmLimit, requestId);
      if (!mRpm.allowed) {
        c.header('retry-after', String(mRpm.retryAfterSec ?? 1));
        return errorResponse(c, 429, 'rate_limit_exceeded', `模型「${model}」请求超限（RPM）`, `请 ${mRpm.retryAfterSec} 秒后重试`);
      }
    }
    if (mapping.tpmLimit) {
      const mTpm = await rateLimiter.checkTpm(`model:${mapping.id}`, estimatedInputTokensForTpm, mapping.tpmLimit);
      if (!mTpm.allowed) {
        c.header('retry-after', String(mTpm.retryAfterSec ?? 1));
        return errorResponse(c, 429, 'rate_limit_exceeded', `模型「${model}」Token 超限（TPM）`, `请 ${mTpm.retryAfterSec} 秒后重试`);
      }
    }

    // ---- 预扣计费（billing hold）----
    // 估算上限 = (估算输入 × 输入价 + 默认输出上限 × 输出价) × 系数（缓存按全价保守估）
    const estimatedInputTokens = estimateTokens(extractRequestChars(body), 3.5);
    const maxOutputTokens =
      typeof body.max_tokens === 'number' && body.max_tokens > 0
        ? body.max_tokens
        : DEFAULT_MAX_OUTPUT_TOKENS;
    const estimate = estimateMaxCost({
      estimatedInputTokens,
      maxOutputTokens,
      inputPrice: mapping.inputPrice,
      outputPrice: mapping.outputPrice,
      coefficientMilli: auth.coefficientMilli,
    });
    const balance = await billing.getBalance(auth.userId);
    const holdAmount = calcHold(estimate, balance, env.HOLD_MAX);
    if (holdAmount <= 0 && balance <= 0) {
      // 余额耗尽才拒绝（estimate=0 但 balance>0 时不拦截：极小请求靠 worker 结算实际扣费）
      return errorResponse(
        c,
        402,
        'insufficient_balance',
        `可用余额不足（当前余额 ${balance} 厘）`,
        '请充值后再试',
      );
    }
    // holdAmount=0（极小请求估算为 0）时跳过预扣，直接放行（靠 worker 结算实际扣费）
    const holdResult = holdAmount > 0
      ? await billing.hold(auth.userId, requestId, holdAmount)
      : { ok: true as const, balance, degraded: false };
    if (!holdResult.ok) {
      return errorResponse(
        c,
        402,
        'insufficient_balance',
        `可用余额不足（当前余额 ${holdResult.balance} 厘，需要预扣 ${holdAmount} 厘）`,
        '请充值后再试',
      );
    }
    logger.debug({ requestId, userId: auth.userId, estimate, holdAmount, balance: holdResult.balance }, 'billing hold');

    // ---- 候选循环（requirements 5.9）----
    // 主模型渠道 → 全失败 → fallback 模型渠道 → 全失败 → 503
    // 每个渠道内：ai 包 withRetry 已覆盖同渠道重试；gateway 层只做「换渠道」
    const mainChannels = await resolveChannels(db, mapping.realModel);
    // fallback 模型的渠道列表（lazy 查询：仅主模型全失败时才解析）
    const fallbackTargets: Array<{ realModel: string; channels: ResolvedChannel[] }> = [];
    for (const fb of mapping.fallbackModels ?? []) {
      const fbMapping = await db.query.modelMappings.findFirst({
        where: and(eq(modelMappings.externalName, fb), eq(modelMappings.status, 0)),
      });
      if (fbMapping) {
        fallbackTargets.push({ realModel: fbMapping.realModel, channels: await resolveChannels(db, fbMapping.realModel) });
      }
    }
    const targets = [{ realModel: mapping.realModel, channels: mainChannels }, ...fallbackTargets];

    if (targets.every((t) => t.channels.length === 0)) {
      await billing.release(auth.userId, requestId);
      return errorResponse(c, 503, 'no_available_channel', `模型「${model}」当前无可用渠道`);
    }

    let lastError: { code: string; message: string; status: number; suggestion?: string } | null = null;
    // settled=true 表示请求成功且 hold 保持（worker 结算时释放）；false 表示需要 gateway 释放 hold
    let settled = false;

    try {
      for (const target of targets) {
        if (target.channels.length === 0) continue;
        const ctx = {
          requestId,
          model: target.realModel,
          providerName: target.channels[0]!.providerName,
          paramRules: mapping.paramRules ?? undefined,
        };

        for (const channel of target.channels) {
          logger.info({ requestId, channel: channel.key, model: target.realModel, stream }, 'candidate attempt');
          const channelDesc: ChannelDesc = { baseUrl: channel.baseUrl, apiKey: channel.apiKey, protocol: channel.protocol };

          // 上游调用 Span（渠道级，OTel 链路追踪）
          const upSpan: Span | undefined = upstreamTracer.startSpan(`upstream ${channel.providerName}`);
          upSpan.setAttributes({ 'channel.id': channel.channelId, 'channel.key': channel.key, 'ai.model': target.realModel, 'ai.attempt_stream': stream });
          try {
            if (stream) {
              // 流式：直接 fetch 上游 + new Response(res.body) 透传（真流式，不缓冲）
              // 旁路扫描（usage/计量）用 tee 分支，不阻塞主流
              const upUrl = channelDesc.baseUrl + '/v1/chat/completions';
              const upRes = await fetch(upUrl, {
                method: 'POST',
                headers: {
                  authorization: `Bearer ${channelDesc.apiKey}`,
                  'content-type': 'application/json',
                },
                body: JSON.stringify({ ...body, model: target.realModel, stream: true }),
              });
              if (upRes.status >= 400) {
                const errBody = await upRes.text().catch(() => '');
                logger.warn({ requestId, channel: channel.key, status: upRes.status, body: errBody.slice(0, 200) }, 'upstream stream error');
                lastError = { code: 'upstream_error', message: '上游错误', status: upRes.status };
                recordChannelFailure(channel.key);
                continue;
              }
              if (!upRes.body) {
                lastError = { code: 'upstream_error', message: '上游无响应体', status: 502 };
                continue;
              }
              // tee：主流透传给客户端（真流式），旁路分支扫描 usage
              const [mainStream, scanStream] = upRes.body.tee();
              // 旁路扫描（fire-and-forget，不阻塞响应）
              void (async (): Promise<void> => {
                const reader = scanStream.getReader();
                const decoder = new TextDecoder();
                let buf = '';
                let bytesRelayed = 0;
                try {
                  for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    bytesRelayed += value.byteLength;
                    buf += decoder.decode(value, { stream: true });
                    // 解析 SSE 帧找 usage
                    const lines = buf.split('\n');
                    buf = lines.pop() ?? '';
                    for (const line of lines) {
                      if (line.startsWith('data: ') && line.includes('"usage"')) {
                        try {
                          const data = JSON.parse(line.slice(6));
                          if (data.usage) {
                            const usage = normalizeUpstreamUsage(data.usage);
                            logger.info({ requestId, channel: channel.key, usage }, 'stream usage captured');
                            void enqueueMeter(usage, 0, channel.channelId, target.realModel, false);
                          }
                        } catch { /* 非 JSON，跳过 */ }
                      }
                    }
                  }
                } catch { /* 客户端断开等 */ }
                recordRequest(target.realModel, 200, 0);
              })();
              settled = true;
              // 用 Hono c.header + c.body（而非 new Response）：
              // 实测 new Response(stream) 在 chat-completions 路由链下被缓冲，
              // c.body 走 Hono 的原生流式路径
              c.header('content-type', 'text/event-stream; charset=utf-8');
              c.header('cache-control', 'no-cache');
              c.header('x-request-id', requestId);
              return c.body(mainStream);
            }

            // 非流式
            const result = await ai.chat({ channel: channelDesc, request: body, ctx });
            if (result.status === 'success') {
              logger.info({ requestId, channel: channel.key, usage: result.usage }, 'chat success');
              // 计量入队
              if (result.usage) {
                void enqueueMeter(result.usage, result.durationMs, channel.channelId, target.realModel, false);
              }
              // hold 保持到 worker 结算
              recordRequest(target.realModel, 200, result.durationMs);
              settled = true;
              // 直接透传上游完整响应体（含 choices/message/content + usage）
              return c.json(result.body ?? {
                id: 'chatcmpl-' + requestId.slice(0, 24),
                object: 'chat.completion',
                model: target.realModel,
                choices: [],
              });
            }
            // 失败：判断是否换渠道
            const err = result.error;
            if (isChannelSwitchable(err?.code)) {
              lastError = { code: err!.code, message: err!.message, status: err!.status ?? 502, suggestion: err!.suggestion };
              logger.warn({ requestId, channel: channel.key, code: err!.code }, 'candidate failed, switching');
              recordChannelFailure(channel.key);
              // 死凭据 → 写回 DB status=4（永久退出路由 + 管理端可见）
              if (isDeadCredentialError(err?.code)) {
                void markChannelDeadCredential(db, channel.channelId, logger);
              }
              continue; // 换渠道
            }
            // 不可换渠道的错误（4xx 客户端问题）→ 直接返回
            const httpStatus = err?.status ?? 502;
            return errorResponse(
              c,
              httpStatus >= 400 && httpStatus < 600 ? httpStatus : 502,
              err?.code ?? 'upstream_error',
              err?.message ?? '上游错误',
              err?.suggestion,
            );
          } catch (err) {
            logger.error({ requestId, channel: channel.key, err }, 'candidate unexpected error');
            lastError = { code: 'upstream_error', message: '网关内部错误', status: 500 };
            upSpan?.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
            continue; // 换渠道
          } finally {
            upSpan?.end();
          }
        }
        // 该模型所有渠道失败 → 尝试下一个 fallback 模型
      }

      // 全部候选耗尽 → 503（返回首个有意义的错误）
      const code = lastError?.code ?? 'no_available_channel';
      const message = lastError?.message ?? `模型「${model}」所有渠道均不可用`;
      return errorResponse(c, 503, code, message, lastError?.suggestion);
    } finally {
      // settled=false 表示请求未成功（失败/异常/全渠道耗尽）→ 释放 hold
      // settled=true 表示成功（hold 保持，worker 结算时删 hold + 刷 Redis）
      if (!settled) {
        try {
          await billing.release(auth.userId, requestId);
        } catch (e) {
          logger.warn({ requestId, err: e }, 'billing release failed');
        }
      }
    }
  });

  return app;
}

// ---- 渠道解析 + 候选循环（requirements 5.9） ----

interface ResolvedChannel {
  channelId: number;
  baseUrl: string;
  apiKey: string;
  protocol: ChannelDesc['protocol'];
  providerName: string;
  key: string;
}

/**
 * 解析模型的所有可用候选渠道（status=0 启用），按 priority DESC + weight DESC 排序。
 * 熔断/凭据无效/禁用的渠道由 ai 包的 breaker/canRequest 在调用时过滤（gateway 层不查 Redis 状态）。
 */
async function resolveChannels(db: Db, realModel: string): Promise<ResolvedChannel[]> {
  const rows = await db
    .select({
      channelId: channels.id,
      channelName: channels.name,
      apiKeyEnc: channels.apiKeyEnc,
      baseUrlOverride: channels.baseUrlOverride,
      providerName: providers.name,
      providerBaseUrl: providers.baseUrl,
      providerProtocol: providers.protocol,
      mcWeight: modelChannels.weight,
      mcPriority: modelChannels.priority,
    })
    .from(modelChannels)
    .innerJoin(channels, eq(modelChannels.channelId, channels.id))
    .innerJoin(providers, eq(channels.providerId, providers.id))
    .innerJoin(modelMappings, eq(modelChannels.mappingId, modelMappings.id))
    .where(and(eq(modelMappings.realModel, realModel), eq(channels.status, 0)))
    .orderBy(desc(modelChannels.priority), desc(modelChannels.weight));

  return rows.map((row) => ({
    channelId: row.channelId,
    baseUrl: row.baseUrlOverride ?? row.providerBaseUrl,
    apiKey: decrypt(row.apiKeyEnc, env.ENCRYPTION_KEY),
    protocol: row.providerProtocol.replace('_', '-') as ChannelDesc['protocol'],
    providerName: row.providerName,
    key: `${row.providerName}/${row.channelName}`,
  }));
}

/**
 * 判断错误是否值得换渠道（vs 直接返回客户端）：
 *   换渠道：5xx/网络/超时/死凭据/熔断/限流/空完成（渠道问题或配置问题，别的渠道可能好的）
 *   不换：400/404/413 等 4xx 客户端错误（换渠道也一样会失败）
 */
const CHANNEL_SWITCHABLE_CODES = new Set([
  'upstream_error',
  'network',
  'timeout',
  'rate_limited',
  'quota_exhausted',
  'circuit_open',
  'dead_credential',
  'invalid_api_key', // 401 死凭据：此渠道 key 坏了，别的渠道可能好
  'forbidden', // 403：同上
  'empty_completion',
  'invalid_response',
]);

function isChannelSwitchable(code: string | undefined): boolean {
  return code ? CHANNEL_SWITCHABLE_CODES.has(code) : false;
}
