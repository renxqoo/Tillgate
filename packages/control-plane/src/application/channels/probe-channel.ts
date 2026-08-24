/**
 * 渠道连通性探针：真实解密 + 独立探针实例；回显仅 keyPreview（坏密文时无预览）。
 * 适配器异常与密文损坏（decrypt 抛）都是探针结果，不是管理面错误。
 */
import type { Db } from '@tillgate/db';
import type { ChannelStore } from '../../ports/channel-store';
import type { UpstreamProbe } from '../../ports/upstream-probe';
import type { SecretCipher } from '../../ports/secret-cipher';
import { maskUpstreamKey } from '../../domain/channel/channel';
import { controlPlaneErrors } from '../../errors';

export interface ProbeChannelDeps {
  readonly db: Db;
  readonly stores: { readonly channel: ChannelStore };
  readonly cipher: SecretCipher;
  readonly probe: UpstreamProbe;
}

export interface ProbeChannelResult {
  readonly ok: boolean;
  readonly durationMs: number;
  readonly error?: { code: string; message: string };
  readonly keyPreview?: string;
}

export async function probeChannel(
  deps: ProbeChannelDeps,
  channelId: number,
): Promise<ProbeChannelResult> {
  const channel = await deps.stores.channel.findChannelForProbe(deps.db, channelId);
  if (!channel) {
    throw controlPlaneErrors.business('channel_not_found', { channelId });
  }
  const startedAt = Date.now();
  try {
    const apiKey = deps.cipher.decrypt(channel.apiKeyEnc);
    const keyPreview = maskUpstreamKey(apiKey);
    const result = await deps.probe.probeChannel({
      baseUrl: channel.baseUrlOverride ?? channel.providerBaseUrl,
      apiKey,
      protocol: channel.providerProtocol,
    });
    return {
      ok: result.ok,
      durationMs: result.durationMs,
      error: result.error ? { code: result.error.code, message: result.error.message } : undefined,
      keyPreview,
    };
  } catch (error) {
    // 适配器异常与密文损坏都是探针结果——坏密文不回预览（keyPreview 缺省）
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
    };
  }
}
