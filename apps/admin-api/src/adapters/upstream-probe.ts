/**
 * 上游探针桥接件（装配面——仅 assembly.ts 引用，architecture 测试锁定）。
 * control-plane 的 UpstreamProbe port 由 ai 库包装实现：每次探针新建 createAi 实例
 * （内存态熔断/死凭据不跨探针共享、不污染网关——control-plane DESIGN §装配注入）。
 * 渠道连通性 = ai.probe；模型测试 = "1" + max_tokens=1 真实请求（请求内零重试）。
 */
import { createAi, type Ai } from '@tillgate/ai';
import type { UpstreamError } from '@tillgate/ai';
import type { ProbeOutcome, ProbeTarget, UpstreamProbe } from '@tillgate/control-plane';

function errorFace(error: UpstreamError): { code: string; message: string } {
  return { code: error.vendorCode ?? error.kind, message: error.message };
}

/**
 * @param aiFactory 探针实例工厂（缺省 createAi——每次调用新实例:内存态熔断/死凭据
 *   不跨探针共享、不污染网关;测试注入替身工厂）
 */
export function createUpstreamProbe(aiFactory: () => Ai = createAi): UpstreamProbe {
  return {
    async probeChannel(target: ProbeTarget): Promise<ProbeOutcome> {
      const outcome = await aiFactory().probe({
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
        protocol: target.protocol,
      });
      return {
        ok: outcome.ok,
        durationMs: outcome.durationMs,
        ...(outcome.error !== undefined ? { error: errorFace(outcome.error) } : {}),
      };
    },
    async probeModel(target: ProbeTarget, model: string, ctx: { requestId: string }) {
      const result = await aiFactory().chat(
        { baseUrl: target.baseUrl, apiKey: target.apiKey, protocol: target.protocol },
        { model, messages: [{ role: 'user', content: '1' }], max_tokens: 1 },
        { requestId: ctx.requestId, maxRetries: 0 },
      );
      if (!result.ok) {
        return { ok: false, durationMs: result.durationMs, error: errorFace(result.error) };
      }
      return {
        ok: true,
        durationMs: result.durationMs,
        ...(result.usage !== undefined
          ? { tokens: result.usage.inputTokens + result.usage.outputTokens }
          : {}),
      };
    },
  };
}
