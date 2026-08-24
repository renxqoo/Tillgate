/**
 * 模型探针：逐渠道最小成本生成（"1" + max_tokens=1 真实请求，请求内零重试）。
 * 密钥真实解密后仅入探针调用内存；结果含 tokens 汇总，上游失败错误码透传。
 */
import type { Db } from '@tillgate/db';
import type { ModelStore } from '../../ports/model-store';
import type { UpstreamProbe } from '../../ports/upstream-probe';
import type { SecretCipher } from '../../ports/secret-cipher';
import { controlPlaneErrors } from '../../errors';

export interface ProbeModelDeps {
  readonly db: Db;
  readonly stores: { readonly model: ModelStore };
  readonly cipher: SecretCipher;
  readonly probe: UpstreamProbe;
}

export interface ProbeModelResult {
  readonly results: Array<{
    channelId: number;
    channel: string;
    ok: boolean;
    durationMs: number;
    tokens?: number;
    error?: { code: string; message: string };
  }>;
}

// eslint-disable-next-line max-lines-per-function -- 探测编排:逐渠道探测循环+结果归并
export async function probeModel(
  deps: ProbeModelDeps,
  mappingId: number,
): Promise<ProbeModelResult> {
  const existing = await deps.stores.model.findById(deps.db, mappingId);
  if (!existing) {
    throw controlPlaneErrors.business('model_not_found', { mappingId });
  }
  const channels = await deps.stores.model.listBoundChannelsForProbe(deps.db, mappingId);

  const results: ProbeModelResult['results'] = [];
  for (const channel of channels) {
    const startedAt = Date.now();
    try {
      const apiKey = deps.cipher.decrypt(channel.apiKeyEnc);
      const result = await deps.probe.probeModel(
        {
          baseUrl: channel.baseUrlOverride ?? channel.providerBaseUrl,
          apiKey,
          protocol: channel.providerProtocol,
        },
        existing.realModel,
        { requestId: `model-test-${mappingId}-${channel.channelId}` },
      );
      results.push(
        result.ok
          ? {
              channelId: channel.channelId,
              channel: channel.channelName,
              ok: true,
              durationMs: Date.now() - startedAt,
              ...(result.tokens !== undefined ? { tokens: result.tokens } : {}),
            }
          : {
              channelId: channel.channelId,
              channel: channel.channelName,
              ok: false,
              durationMs: Date.now() - startedAt,
              error: result.error ?? {
                code: 'empty_response',
                message: 'Upstream returned empty completion',
              },
            },
      );
    } catch (error) {
      results.push({
        channelId: channel.channelId,
        channel: channel.channelName,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: {
          code:
            error instanceof Error && 'code' in error
              ? String((error as { code: unknown }).code)
              : 'internal',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  return { results };
}
