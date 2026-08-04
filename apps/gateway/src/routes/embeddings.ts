import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { modelMappings, modelChannels, channels, providers } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import { type Ai, type ChannelDesc, estimateTokens, extractRequestChars } from '@ai-gateway/ai';
import { calcHold, estimateMaxCost } from '@ai-gateway/money';
import { decrypt } from '../lib/crypto.js';
import { BillingService } from '../lib/billing.js';
import { RateLimiter } from '../lib/rate-limit.js';
import { MeterProducer } from '../lib/meter.js';
import { recordRequest } from '../lib/metrics.js';
import { jsonBody } from '../lib/validation.js';
import { isModelAllowed } from '../lib/model-scope.js';
import { syncSettle } from '../lib/sync-settle.js';
import { markChannelDeadCredential, isDeadCredentialError } from '../lib/dead-credential-persist.js';
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
export function embeddingsRoutes(
  db: Db,
  ai: Ai,
  billing: BillingService,
  rateLimiter: RateLimiter,
  meter: MeterProducer,
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

    // 限流（RPM + TPM，同 chat）
    const rlResult = await rateLimiter.checkAll(
      [{ dimension: 'global', max: 2000 }, { dimension: `user:${auth.userId}`, max: auth.userRpmLimit ?? env.DEFAULT_USER_RPM }],
      requestId,
    );
    if (!rlResult.allowed) {
      c.header('retry-after', String(rlResult.retryAfterSec ?? 1));
      return errorResponse(c, 429, 'rate_limit_exceeded', `请求过于频繁（${rlResult.dimension}）`, `请 ${rlResult.retryAfterSec} 秒后重试`);
    }

    // 模型路由
    const mapping = await db.query.modelMappings.findFirst({
      where: and(eq(modelMappings.externalName, model), eq(modelMappings.status, 0)),
    });
    if (!mapping) return errorResponse(c, 404, 'model_not_found', `模型「${model}」不存在或已下架`);

    // 预扣
    const estInput = estimateTokens(extractRequestChars(body), 3.5);
    const estimate = estimateMaxCost({ estimatedInputTokens: estInput, maxOutputTokens: 0, inputPrice: mapping.inputPrice, outputPrice: 0, coefficientMilli: auth.coefficientMilli });
    const balance = await billing.getBalance(auth.userId);
    const holdAmount = calcHold(estimate, balance, env.HOLD_MAX);
    // 余额耗尽才拒绝（estimate=0 但 balance>0 时不拦截：靠 worker 结算实际扣费）
    if (holdAmount <= 0 && balance <= 0) return errorResponse(c, 402, 'insufficient_balance', `可用余额不足`, '请充值后再试');
    const holdResult = holdAmount > 0 ? await billing.hold(auth.userId, requestId, holdAmount) : { ok: true as const, balance, degraded: false };
    if (!holdResult.ok) return errorResponse(c, 402, 'insufficient_balance', `可用余额不足`, '请充值后再试');

    // 渠道选择
    const candidates = await resolveChannels(db, mapping.realModel);
    if (candidates.length === 0) {
      await billing.release(auth.userId, requestId);
      return errorResponse(c, 503, 'no_available_channel', `模型「${model}」当前无可用渠道`);
    }

    const ctx = { requestId, model: mapping.realModel, providerName: candidates[0]!.providerName, endpoint: 'embeddings' as const };
    let settled = false;
    let lastError: { code: string; message: string; status: number } | null = null;

    try {
      for (const channel of candidates) {
        const channelDesc: ChannelDesc = { baseUrl: channel.baseUrl, apiKey: channel.apiKey, protocol: channel.protocol };
        try {
          const result = await ai.chat({ channel: channelDesc, request: body, ctx });
          if (result.status === 'success') {
            logger.info({ requestId, channel: channel.key, usage: result.usage }, 'embeddings success');
            if (result.usage) {
              // 资损防线：入队失败（Redis 挂）→ 同步降级结算（DB 兜底），绝不漏扣
              const jobData = { requestId, userId: auth.userId, apiKeyId: auth.apiKeyId, appId: auth.appId, credentialType: auth.credentialType, externalModel: model, realModel: mapping.realModel, channelId: channel.channelId, usage: { inputTokens: result.usage.inputTokens, cachedInputTokens: result.usage.cachedInputTokens, outputTokens: result.usage.outputTokens, estimated: result.usage.estimated }, inputPrice: mapping.inputPrice, outputPrice: mapping.outputPrice, cacheInputPrice: mapping.cacheInputPrice, coefficient: auth.coefficientMilli / 1000, coefficientMilli: auth.coefficientMilli, durationMs: result.durationMs, stream: false, streamAborted: false, holdAmount, mappingId: mapping.id };
              void meter.enqueue(jobData).then((r) => {
                if (!r.ok) {
                  logger.warn({ requestId, err: r.error?.message }, 'meter enqueue failed, falling back to sync settle');
                  return syncSettle(db, jobData).catch((e) => {
                    logger.error({ requestId, err: e instanceof Error ? e.message : String(e) }, 'sync settle also failed — revenue loss');
                  });
                }
              });
            }
            recordRequest(mapping.realModel, 200, result.durationMs);
            settled = true;
            return c.json(result.body ?? { model: mapping.realModel, data: [], usage: {} });
          }
          const err = result.error;
          if (err && ['upstream_error', 'network', 'timeout', 'rate_limited', 'invalid_api_key', 'circuit_open'].includes(err.code)) {
            lastError = { code: err.code, message: err.message, status: err.status ?? 502 };
            // 死凭据 → 写回 DB status=4（永久退出路由 + 管理端可见）
            if (isDeadCredentialError(err.code)) {
              void markChannelDeadCredential(db, channel.channelId, logger);
            }
            continue;
          }
          return errorResponse(c, err?.status ?? 502, err?.code ?? 'upstream_error', err?.message ?? '上游错误', err?.suggestion);
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

// 复用 chat-completions 的渠道解析逻辑
async function resolveChannels(db: Db, realModel: string) {
  const rows = await db
    .select({ channelId: channels.id, channelName: channels.name, apiKeyEnc: channels.apiKeyEnc, baseUrlOverride: channels.baseUrlOverride, providerName: providers.name, providerBaseUrl: providers.baseUrl, providerProtocol: providers.protocol, mcWeight: modelChannels.weight, mcPriority: modelChannels.priority })
    .from(modelChannels)
    .innerJoin(channels, eq(modelChannels.channelId, channels.id))
    .innerJoin(providers, eq(channels.providerId, providers.id))
    .innerJoin(modelMappings, eq(modelChannels.mappingId, modelMappings.id))
    .where(and(eq(modelMappings.realModel, realModel), eq(channels.status, 0)))
    .orderBy(desc(modelChannels.priority), desc(modelChannels.weight));
  return rows.map((r) => ({ channelId: r.channelId, baseUrl: r.baseUrlOverride ?? r.providerBaseUrl, apiKey: decrypt(r.apiKeyEnc, env.ENCRYPTION_KEY), protocol: r.providerProtocol.replace('_', '-') as ChannelDesc['protocol'], providerName: r.providerName, key: `${r.providerName}/${r.channelName}` }));
}
