import { Hono } from 'hono';
import type { Db } from '@ai-gateway/db';
import type { Redis } from 'ioredis';
import { type Ai, type ChannelDesc, type Usage, estimateTokens, extractRequestChars } from '@ai-gateway/ai';

import { calcHold, estimateMaxCost, toDecimal } from '@ai-gateway/money';
import { BillingService } from '../lib/billing.js';
import { RateLimiter } from '../lib/rate-limit.js';
import { MeterProducer } from '../lib/meter.js';
import { recordRequest, recordChannelFailure } from '../lib/metrics.js';
import { markChannelDeadCredential, isDeadCredentialError } from '../lib/dead-credential-persist.js';
import { errorResponse, type AuthEnv } from '../middleware/auth.js';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { z } from 'zod';
import { jsonBody } from '../lib/validation.js';
import { estimateStreamUsage, estimateNonStreamUsage } from '../lib/stream-usage.js';
import { syncSettle } from '../lib/sync-settle.js';
import { isModelAllowed } from '../lib/model-scope.js';
import { isChannelSwitchable } from '../lib/channel-switch.js';
import { getMapping, getChannels, type ChannelCache } from '../lib/route-cache.js';
import { env, logger } from '../index.js';

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
/**
 * 全局 RPM 上限（防整站被打；tech-stack §5：2000 RPM/实例）。
 * 全站共享一个 Redis key（多副本合计 ≤ GLOBAL_RPM，非每副本）。
 *
 * B4 修复：原实现从 env 裸读 GLOBAL_RPM 无门控，.env 残留压测值 200000 → 全局限流形同虚设。
 * 现在生产环境（NODE_ENV=production）强制硬上限 5000，开发/测试不限制（便于压测）。
 */
const PROD_GLOBAL_RPM_CAP = 5000;
const GLOBAL_RPM = (() => {
  const v = Number(process.env.GLOBAL_RPM);
  const isProd = process.env.NODE_ENV === 'production';
  if (Number.isFinite(v) && v > 0) {
    return isProd ? Math.min(Math.floor(v), PROD_GLOBAL_RPM_CAP) : Math.floor(v);
  }
  return 2000;
})();

/**
 * POST /v1/chat/completions — 对话补全（OpenAI 格式，含 SSE 流式）
 *
 * 链路：鉴权 → 限流(RPM, global/user/key/app) → 模型路由 → 模型级限流(RPM) + TPM(user:model 拆分) → 预扣(hold) → 渠道选择 → 循环[channel 维度限流 → ai 包调用] → 释放 hold → SSE/JSON
 * 结算（写 usage_logs + transactions + TPM 回填 user:model/model/channel 维度）留 worker 异步队列。
 */
export function chatCompletionsRoutes(db: Db, ai: Ai, billing: BillingService, rateLimiter: RateLimiter, meter: MeterProducer, redis: Redis): Hono<AuthEnv> {
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

    // 模型路由：externalName → model_mappings（走 Redis 缓存，消除热路径每请求查 DB）
    const mappingCache = await getMapping(db, redis, model);
    if (!mappingCache) {
      return errorResponse(c, 404, 'model_not_found', `模型「${model}」不存在或已下架`);
    }
    // 缓存对象与原 Drizzle row 形状兼容（字段名一致），后续直接用 mappingCache 替代 mapping
    const mapping = mappingCache;

    // ---- 模型级 RPM 限流（model_mappings.rpmLimit，保护上游配额）----
    if (mapping.rpmLimit) {
      const mRpm = await rateLimiter.check(`model:${mapping.id}`, mapping.rpmLimit, requestId);
      if (!mRpm.allowed) {
        c.header('retry-after', String(mRpm.retryAfterSec ?? 1));
        return errorResponse(c, 429, 'rate_limit_exceeded', `模型「${model}」请求超限（RPM）`, `请 ${mRpm.retryAfterSec} 秒后重试`);
      }
    }

    // ---- TPM 限流（token/分钟，requirements 4.6）----
    // user 维度按模型拆（user:${id}:model:${mappingId}）：消除同用户多模型共享桶导致的同时 429（G-RL 修复）。
    // 预占 = 输入 token（输出不可预知，不计入当前窗口，由 worker 回填）
    const estimatedInputTokensForTpm = estimateTokens(extractRequestChars(body), 3.5);
    const tpmDims: Array<{ dimension: string; estimatedTokens: number; max: number }> = [
      { dimension: `user:${auth.userId}:model:${mapping.id}`, estimatedTokens: estimatedInputTokensForTpm, max: auth.userTpmLimit ?? env.DEFAULT_USER_TPM },
    ];
    if (mapping.tpmLimit) {
      tpmDims.push({ dimension: `model:${mapping.id}`, estimatedTokens: estimatedInputTokensForTpm, max: mapping.tpmLimit });
    }
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
        inputPrice: String(mapping.inputPrice),
        outputPrice: String(mapping.outputPrice),
        cacheInputPrice: String(mapping.cacheInputPrice),
        coefficient: auth.coefficient,
        durationMs,
        stream,
        streamAborted,
        holdAmount: holdAmount.toString(),
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
      coefficient: auth.coefficient,
    });
    const balance = await billing.getBalance(auth.userId);
    const balanceDec = toDecimal(balance);
    const holdAmount = calcHold(estimate, balanceDec, env.HOLD_MAX);
    if (holdAmount.isZero() && balanceDec.lte(0)) {
      // 余额耗尽才拒绝（estimate=0 但 balance>0 时不拦截：极小请求靠 worker 结算实际扣费）
      return errorResponse(
        c,
        402,
        'insufficient_balance',
        `可用余额不足（当前余额 ${balance} 元）`,
        '请充值后再试',
      );
    }
    // holdAmount=0（极小请求估算为 0）时跳过预扣，直接放行（靠 worker 结算实际扣费）
    const holdResult = !holdAmount.isZero()
      ? await billing.hold(auth.userId, requestId, holdAmount)
      : { ok: true as const, balance };
    if (!holdResult.ok) {
      return errorResponse(
        c,
        402,
        'insufficient_balance',
        `可用余额不足（当前余额 ${holdResult.balance} 元，需要预扣 ${holdAmount.toString()} 元）`,
        '请充值后再试',
      );
    }
    logger.debug({ requestId, userId: auth.userId, estimate: estimate.toString(), holdAmount: holdAmount.toString(), balance: holdResult.balance }, 'billing hold');

    // ---- 候选循环（requirements 5.9）----
    // 主模型渠道 → 全失败 → fallback 模型渠道 → 全失败 → 503
    // 每个渠道内：ai 包 withRetry 已覆盖同渠道重试；gateway 层只做「换渠道」
    // 渠道解析走 Redis 缓存（getChannels），消除热路径多表 JOIN 查 DB
    const mainChannels = await getChannels(db, redis, mapping.realModel, env.ENCRYPTION_KEY);
    // fallback 模型的渠道列表（lazy 查询：仅主模型全失败时才解析）
    const fallbackTargets: Array<{ realModel: string; channels: ResolvedChannel[] }> = [];
    for (const fb of mapping.fallbackModels ?? []) {
      const fbMapping = await getMapping(db, redis, fb);
      if (fbMapping) {
        fallbackTargets.push({ realModel: fbMapping.realModel, channels: await getChannels(db, redis, fbMapping.realModel, env.ENCRYPTION_KEY) });
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

          // ---- 渠道级限流（保护上游 API key 配额；超限换下一个渠道，复用 channel-switch 语义）----
          if (channel.rpmLimit) {
            const cRpm = await rateLimiter.check(`channel:${channel.channelId}`, channel.rpmLimit, requestId);
            if (!cRpm.allowed) {
              logger.warn({ requestId, channel: channel.key, retryAfter: cRpm.retryAfterSec }, 'channel RPM limited, switching');
              lastError = { code: 'rate_limited', message: '渠道请求频率超限', status: 429 };
              continue;
            }
          }
          if (channel.tpmLimit) {
            const cTpm = await rateLimiter.checkTpm(`channel:${channel.channelId}`, estimatedInputTokensForTpm, channel.tpmLimit);
            if (!cTpm.allowed) {
              logger.warn({ requestId, channel: channel.key, retryAfter: cTpm.retryAfterSec }, 'channel TPM limited, switching');
              lastError = { code: 'rate_limited', message: '渠道 Token 用量超限', status: 429 };
              continue;
            }
          }

          const channelDesc: ChannelDesc = { baseUrl: channel.baseUrl, apiKey: channel.apiKey, protocol: channel.protocol };

          // 上游调用 Span（渠道级，OTel 链路追踪）
          const upSpan: Span | undefined = upstreamTracer.startSpan(`upstream ${channel.providerName}`);
          upSpan.setAttributes({ 'channel.id': channel.channelId, 'channel.key': channel.key, 'ai.model': target.realModel, 'ai.attempt_stream': stream });
          try {
            if (stream) {
              const handle = await ai.chatStream({ channel: channelDesc, request: body, ctx });
              const state: { failed: { code: string; message: string } | null } = { failed: null };
              handle.onEvent((e) => {
                if (e.type === 'failed') {
                  state.failed = { code: e.error.code, message: e.error.message };
                  billing.release(auth.userId, requestId).catch(() => {});
                }
                if (e.type === 'success') {
                  logger.info({ requestId, channel: channel.key, usage: e.usage, terminated: e.terminated, bytesRelayed: e.bytesRelayed }, 'stream completed');
                  recordRequest(target.realModel, 200, e.durationMs);
                  const usage = e.usage ?? estimateStreamUsage(body, e.bytesRelayed ?? 0);
                  if (usage) {
                    void enqueueMeter(usage, e.durationMs, channel.channelId, target.realModel, !!e.terminated);
                  } else {
                    // G1 修复：上游已实际执行（平台已付钱），即便无 usage + 0 字节也不能跳过计量——
                    // 否则 settled=true 但不入队 → worker 不结算 → 漏计费 + hold 残留到 TTL（10min 锁余额）。
                    // 兜底：按输入 token 估算（输入是真实成本；输出 0）。标 estimated=true 供审计识别。
                    const fallbackUsage = {
                      inputTokens: estimateTokens(extractRequestChars(body), 3.5),
                      cachedInputTokens: 0,
                      outputTokens: 0,
                      estimated: true,
                      raw: { source: 'gateway_input_only_fallback', bytesRelayed: e.bytesRelayed ?? 0 },
                    };
                    logger.warn({ requestId, channel: channel.key, bytesRelayed: e.bytesRelayed, inputTokens: fallbackUsage.inputTokens }, 'stream ended without usage/output, metering input tokens only');
                    void enqueueMeter(fallbackUsage, e.durationMs, channel.channelId, target.realModel, !!e.terminated);
                  }
                }
              });
              if (state.failed && isChannelSwitchable(state.failed.code)) {
                lastError = { code: state.failed.code, message: state.failed.message, status: 502 };
                logger.warn({ requestId, channel: channel.key, code: state.failed.code }, 'candidate failed, switching');
                recordChannelFailure(channel.key);
                if (isDeadCredentialError(state.failed.code)) {
                  void markChannelDeadCredential(db, channel.channelId, logger, redis);
                }
                continue;
              }
              settled = true;
              return new Response(handle.stream, {
                headers: {
                  'content-type': 'text/event-stream; charset=utf-8',
                  'cache-control': 'no-cache',
                  connection: 'keep-alive',
                  'x-request-id': requestId,
                },
              });
            }

            // 非流式
            const result = await ai.chat({ channel: channelDesc, request: body, ctx });
            if (result.status === 'success') {
              logger.info({ requestId, channel: channel.key, usage: result.usage }, 'chat success');
              // 计量入队（usage 缺失时兜底估算，防漏计费 + hold 残留；与流式分支对称）
              const usage = result.usage ?? estimateNonStreamUsage(body, result.body);
              if (usage) {
                void enqueueMeter(usage, result.durationMs, channel.channelId, target.realModel, false);
              } else {
                logger.warn({ requestId, channel: channel.key }, 'non-stream success without usage, skip metering');
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
                void markChannelDeadCredential(db, channel.channelId, logger, redis);
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

/** 候选渠道（渠道解析走 Redis 缓存，见 route-cache.ts 的 ChannelCache） */
type ResolvedChannel = ChannelCache;

// isChannelSwitchable 已抽到 lib/channel-switch.ts，与 embeddings 路由共用，杜绝两路由漂移。
