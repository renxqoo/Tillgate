import { Hono } from 'hono';
import type { Db } from '@ai-gateway/db';
import type { Redis } from 'ioredis';
import { type Ai, type ChannelDesc, estimateTokens, extractRequestChars } from '@ai-gateway/ai';
import { calcHold, estimateMaxCost, toDecimal } from '@ai-gateway/money';
import { BillingService } from '../lib/billing.js';
import { RateLimiter } from '../lib/rate-limit.js';
import { MeterProducer } from '../lib/meter.js';
import { recordRequest } from '../lib/metrics.js';
import { jsonBody } from '../lib/validation.js';
import { isModelAllowed } from '../lib/model-scope.js';
import { isChannelSwitchable } from '../lib/channel-switch.js';
import { syncSettle } from '../lib/sync-settle.js';
import { markChannelDeadCredential, isDeadCredentialError } from '../lib/dead-credential-persist.js';
import { getMapping, getChannels } from '../lib/route-cache.js';
import { estimateNonStreamUsage } from '../lib/stream-usage.js';
import { errorResponse, type AuthEnv } from '../middleware/auth.js';
import { z } from 'zod';
import { env, logger } from '../index.js';

/** embeddings 请求 schema */
const embedSchema = z
  .object({
    model: z.string().min(1, 'model 不能为空'),
    input: z.union([z.string(), z.array(z.string())]),
  })
  .passthrough();

/**
 * POST /v1/embeddings — 向量化（OpenAI 标准，api-contract §2.5）
 * 透传 + usage 计量，规则同 chat（鉴权 → 限流 → 预扣 → 渠道 → ai.chat(endpoint=embeddings)）。
 * 非流式（embeddings 无 SSE）。
 */

/** 全局 RPM 上限（与 chat-completions 一致：生产硬上限 5000，开发可配） */
const PROD_GLOBAL_RPM_CAP = 5000;
const GLOBAL_RPM = (() => {
  const v = Number(process.env.GLOBAL_RPM);
  const isProd = process.env.NODE_ENV === 'production';
  if (Number.isFinite(v) && v > 0) {
    return isProd ? Math.min(Math.floor(v), PROD_GLOBAL_RPM_CAP) : Math.floor(v);
  }
  return 2000;
})();
export function embeddingsRoutes(
  db: Db,
  ai: Ai,
  billing: BillingService,
  rateLimiter: RateLimiter,
  meter: MeterProducer,
  redis: Redis,
): Hono<AuthEnv> {
  return new Hono<AuthEnv>().post('/', jsonBody(embedSchema), async (c) => {
    const auth = c.var.auth;
    const requestId = c.var.requestId;
    const body = c.req.valid('json') as Record<string, unknown>;
    const model = body.model as string;

    // JWT scope.models 越权校验（S3，同 chat）
    if (!isModelAllowed(auth.allowedModels, model)) {
      return errorResponse(c, 403, 'model_not_allowed', `模型「${model}」不在当前凭证的可用范围内`);
    }

    // ---- 限流（RPM，对齐 chat-completions：global / user / key / app）----
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
      return errorResponse(c, 429, 'rate_limit_exceeded', `请求过于频繁（${rlResult.dimension} 维度超限）`, `请 ${rlResult.retryAfterSec} 秒后重试`);
    }

    // 模型路由（走 Redis 缓存）
    const mapping = await getMapping(db, redis, model);
    if (!mapping) return errorResponse(c, 404, 'model_not_found', `模型「${model}」不存在或已下架`);

    // 输入 token 估算（TPM 预占 + 预扣共用）
    const estInput = estimateTokens(extractRequestChars(body), 3.5);

    // ---- 模型级 RPM 限流（对齐 chat-completions）----
    if (mapping.rpmLimit) {
      const mRpm = await rateLimiter.check(`model:${mapping.id}`, mapping.rpmLimit, requestId);
      if (!mRpm.allowed) {
        c.header('retry-after', String(mRpm.retryAfterSec ?? 1));
        return errorResponse(c, 429, 'rate_limit_exceeded', `模型「${model}」请求超限（RPM）`, `请 ${mRpm.retryAfterSec} 秒后重试`);
      }
    }

    // ---- TPM 限流（user 维度按模型拆，对齐 chat-completions）----
    const tpmDims: Array<{ dimension: string; estimatedTokens: number; max: number }> = [
      { dimension: `user:${auth.userId}:model:${mapping.id}`, estimatedTokens: estInput, max: auth.userTpmLimit ?? env.DEFAULT_USER_TPM },
    ];
    if (mapping.tpmLimit) {
      tpmDims.push({ dimension: `model:${mapping.id}`, estimatedTokens: estInput, max: mapping.tpmLimit });
    }
    if (auth.apiKeyId !== null && auth.keyTpmLimit !== null) {
      tpmDims.push({ dimension: `key:${auth.apiKeyId}`, estimatedTokens: estInput, max: auth.keyTpmLimit });
    }
    if (auth.appId !== null && auth.appTpmLimit !== null) {
      tpmDims.push({ dimension: `app:${auth.appId}`, estimatedTokens: estInput, max: auth.appTpmLimit });
    }
    const tpmResult = await rateLimiter.checkTpmAll(tpmDims);
    if (!tpmResult.allowed) {
      c.header('retry-after', String(tpmResult.retryAfterSec ?? 1));
      return errorResponse(c, 429, 'rate_limit_exceeded', `Token 用量超限（${tpmResult.dimension} 维度 TPM）`, `请 ${tpmResult.retryAfterSec} 秒后重试`);
    }

    // 预扣
    const estimate = estimateMaxCost({ estimatedInputTokens: estInput, maxOutputTokens: 0, inputPrice: mapping.inputPrice, outputPrice: 0, coefficient: auth.coefficient });
    const balance = await billing.getBalance(auth.userId);
    const balanceDec = toDecimal(balance);
    const holdAmount = calcHold(estimate, balanceDec, env.HOLD_MAX);
    // 余额耗尽才拒绝（estimate=0 但 balance>0 时不拦截：靠 worker 结算实际扣费）
    if (holdAmount.isZero() && balanceDec.lte(0)) return errorResponse(c, 402, 'insufficient_balance', `可用余额不足`, '请充值后再试');
    const holdResult = !holdAmount.isZero() ? await billing.hold(auth.userId, requestId, holdAmount) : { ok: true as const, balance };
    if (!holdResult.ok) return errorResponse(c, 402, 'insufficient_balance', `可用余额不足`, '请充值后再试');

    // 渠道选择（走 Redis 缓存）
    const candidates = await getChannels(db, redis, mapping.realModel, env.ENCRYPTION_KEY);
    if (candidates.length === 0) {
      await billing.release(auth.userId, requestId);
      return errorResponse(c, 503, 'no_available_channel', `模型「${model}」当前无可用渠道`);
    }

    const ctx = { requestId, model: mapping.realModel, providerName: candidates[0]!.providerName, endpoint: 'embeddings' as const };
    let settled = false;
    let lastError: { code: string; message: string; status: number } | null = null;

    try {
      for (const channel of candidates) {
        // ---- 渠道级限流（保护上游 API key 配额；超限换下一个渠道）----
        if (channel.rpmLimit) {
          const cRpm = await rateLimiter.check(`channel:${channel.channelId}`, channel.rpmLimit, requestId);
          if (!cRpm.allowed) {
            logger.warn({ requestId, channel: channel.key, retryAfter: cRpm.retryAfterSec }, 'channel RPM limited, switching');
            lastError = { code: 'rate_limited', message: '渠道请求频率超限', status: 429 };
            continue;
          }
        }
        if (channel.tpmLimit) {
          const cTpm = await rateLimiter.checkTpm(`channel:${channel.channelId}`, estInput, channel.tpmLimit);
          if (!cTpm.allowed) {
            logger.warn({ requestId, channel: channel.key, retryAfter: cTpm.retryAfterSec }, 'channel TPM limited, switching');
            lastError = { code: 'rate_limited', message: '渠道 Token 用量超限', status: 429 };
            continue;
          }
        }

        const channelDesc: ChannelDesc = { baseUrl: channel.baseUrl, apiKey: channel.apiKey, protocol: channel.protocol };
        try {
          const result = await ai.chat({ channel: channelDesc, request: body, ctx });
          if (result.status === 'success') {
            logger.info({ requestId, channel: channel.key, usage: result.usage }, 'embeddings success');
            // usage 缺失时兜底估算（防漏计费 + hold 残留，与 chat-completions 非流式对称）
            const usage = result.usage ?? estimateNonStreamUsage(body, result.body);
            if (usage) {
              // 资损防线：入队失败（Redis 挂）→ 同步降级结算（DB 兜底），绝不漏扣
              const jobData = { requestId, userId: auth.userId, apiKeyId: auth.apiKeyId, appId: auth.appId, credentialType: auth.credentialType, externalModel: model, realModel: mapping.realModel, channelId: channel.channelId, usage: { inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens, outputTokens: usage.outputTokens, estimated: usage.estimated }, inputPrice: String(mapping.inputPrice), outputPrice: String(mapping.outputPrice), cacheInputPrice: String(mapping.cacheInputPrice), coefficient: auth.coefficient, durationMs: result.durationMs, stream: false, streamAborted: false, holdAmount: holdAmount.toString(), mappingId: mapping.id };
              void meter.enqueue(jobData).then((r) => {
                if (!r.ok) {
                  logger.warn({ requestId, err: r.error?.message }, 'meter enqueue failed, falling back to sync settle');
                  return syncSettle(db, jobData).catch((e) => {
                    logger.error({ requestId, err: e instanceof Error ? e.message : String(e) }, 'sync settle also failed — revenue loss');
                  });
                }
              });
            } else {
              logger.warn({ requestId, channel: channel.key }, 'embeddings success without usage, skip metering');
            }
            recordRequest(mapping.realModel, 200, result.durationMs);
            settled = true;
            return c.json(result.body ?? { model: mapping.realModel, data: [], usage: {} });
          }
          const err = result.error;
          // 渠道切换判定与 chat-completions 共用（lib/channel-switch），避免两路由漂移。
          if (isChannelSwitchable(err?.code)) {
            lastError = { code: err!.code, message: err!.message, status: err!.status ?? 502 };
            // 死凭据 → 写回 DB status=4（永久退出路由 + 管理端可见）
            if (isDeadCredentialError(err?.code)) {
              void markChannelDeadCredential(db, channel.channelId, logger, redis);
            }
            continue;
          }
          // 不可换渠道的错误（4xx 客户端问题）→ 直接返回，状态码夹到 [400,600)
          const httpStatus = err?.status ?? 502;
          return errorResponse(
            c,
            httpStatus >= 400 && httpStatus < 600 ? httpStatus : 502,
            err?.code ?? 'upstream_error',
            err?.message ?? '上游错误',
            err?.suggestion,
          );
        } catch {
          lastError = { code: 'upstream_error', message: '内部错误', status: 500 };
          continue;
        }
      }
      return errorResponse(c, 503, lastError?.code ?? 'no_available_channel', lastError?.message ?? '所有渠道不可用');
    } finally {
      if (!settled) await billing.release(auth.userId, requestId).catch(() => {});
    }
  });
}
