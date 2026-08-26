/**
 * 端点路由（v1 routes/inference-endpoints.ts 的路由段迁移）：
 * schema 校验 → 限流准入（TPM 保守上界预占）→（codec 端点先 decode）→
 * inference.chat/stream → 信封三态出站。鉴权由 app 按路径挂载。
 */
import { Hono } from 'hono';
import type { Inference } from '@tillgate/inference';
import { conservativeInputTokenUpperBound } from '@tillgate/inference';
import type { AuthEnv } from '../middleware/api-key';
import { toInferenceInput } from './inference-input';
import { admitRequest, type RateLimitGate } from '../middleware/rate-limit';
import { GatewayErrors } from '../openai-error-face';
import { encodeDelivered } from '../openai-envelope';
import type { InferenceEndpoint } from '../contracts/inference-endpoints';
import { requestSummaryOf } from '../middleware/request-log.js';

/** 路由依赖（装配注入；rateLimit 未装配 = 放行——单副本开发形态） */
export interface InferenceRouteDeps {
  inference: Inference;
  rateLimit?: RateLimitGate;
}

function invalidBody(json: (b: unknown, s: 400) => Response, issues: { message?: string }[]) {
  return json(
    {
      error: {
        code: GatewayErrors.code('invalid_body'),
        message: issues[0]?.message ?? 'invalid request body',
      },
    },
    400,
  );
}

/** 端点入站解码：codec 端点外部体 → 规范形；非规范形 chat 的端点族强制非流式 */
function toCanonicalBody(
  endpoint: InferenceEndpoint,
  parsed: Record<string, unknown>,
  externalModel: string,
): Record<string, unknown> {
  // codec 端点：外部体 → 规范形（估算/计费/上游全用规范形）
  const canonical = endpoint.codec
    ? endpoint.codec.decodeRequest(parsed, externalModel)
    : { ...parsed };
  if (endpoint.kind !== 'chat' && endpoint.codec === undefined) {
    canonical.stream = false; // 非规范形 chat 的端点族无流式（embeddings/模态 JSON 族）
  }
  return canonical;
}

/** 出站编码选项：codec 端点带上双向翻译，规范形端点透传 */
function encodeOptionsOf(endpoint: InferenceEndpoint, model: string, requestId: string) {
  return {
    ...(endpoint.codec != null
      ? {
          encodeResponse: endpoint.codec.encodeResponse,
          encodeStream: endpoint.codec.encodeStream,
        }
      : {}),
    model,
    requestId,
  };
}

/** 限流准入 + 推理调用（chat/stream 分派）；失败释放 TPM 预占（零上游执行） */
export function inferenceRoutes(
  deps: InferenceRouteDeps,
  endpoint: InferenceEndpoint,
): Hono<AuthEnv> {
  return new Hono<AuthEnv>().post('/', async (c) => {
    const raw = (await c.req.json().catch(() => null)) as unknown;
  const summary = requestSummaryOf(c.req.method, raw);
  if (summary != null) c.set('requestLogSummary', summary);
    const parsed = endpoint.schema.safeParse(raw);
    if (!parsed.success) return invalidBody(c.json.bind(c), parsed.error.issues);

    const auth = c.get('auth');
    const requestId = c.get('requestId');
    const externalModel = (parsed.data as { model: string }).model;
    const canonical = toCanonicalBody(endpoint, parsed.data, externalModel);

    const admit = await admitRequest(deps.rateLimit, {
      requestId,
      auth,
      estimatedTokens: conservativeInputTokenUpperBound(canonical),
    });
    try {
      const input = toInferenceInput({
        requestId,
        auth,
        body: canonical,
        endpoint: endpoint.kind,
      });
      const result =
        canonical.stream === true
          ? await deps.inference.stream(input)
          : await deps.inference.chat(input);
      return await encodeDelivered(
        c.json.bind(c),
        result,
        encodeOptionsOf(endpoint, externalModel, requestId),
      );
    } catch (error) {
      // 零上游执行的失败（鉴权后异常/目录未命中/预算拒绝）归还 TPM 预占——宁可归还
      // 也不过度占用窗口（成功路径由结算 backfill 归还，失败路径 TTL 兜底）
      await admit.release();
      throw error;
    }
  });
}

/**
 * OpenAI legacy 引擎别名路由（pre-1.0 SDK 的 /v1/engines/:model/embeddings）：
 * 路径段模型名注入 body.model 后走端点同一管线（鉴权/计费/计量完全一致）。
 * 挂载路径已带 :model 参数段（app.route('/v1/engines/:model', …)——param 全程可见）。
 */
export function enginesAliasRoutes(
  deps: InferenceRouteDeps,
  endpoint: InferenceEndpoint,
): Hono<AuthEnv> {
  return new Hono<AuthEnv>().post('/embeddings', async (c) => {
    const raw = (await c.req.json().catch(() => null)) as unknown;
    const aliasSummary = requestSummaryOf(c.req.method, raw);
    if (aliasSummary != null) c.set('requestLogSummary', aliasSummary);
    const model = c.req.param('model');
    const merged = { ...(raw as Record<string, unknown> | null), model };
    const parsed = endpoint.schema.safeParse(merged);
    if (!parsed.success) return invalidBody(c.json.bind(c), parsed.error.issues);
    const auth = c.get('auth');
    const requestId = c.get('requestId');
    const canonical = { ...parsed.data, stream: false };
    const admit = await admitRequest(deps.rateLimit, {
      requestId,
      auth,
      estimatedTokens: conservativeInputTokenUpperBound(canonical),
    });
    try {
      const result = await deps.inference.chat(
        toInferenceInput({ requestId, auth, body: canonical, endpoint: endpoint.kind }),
      );
      return await encodeDelivered(
        c.json.bind(c),
        result,
        encodeOptionsOf(endpoint, (canonical as unknown as { model: string }).model, requestId),
      );
    } catch (error) {
      await admit.release();
      throw error;
    }
  });
}
