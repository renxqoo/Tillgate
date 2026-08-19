/**
 * 连通性探测（从 create-ai.probe 拆出）：适配器探测请求逐个尝试，
 * 任一 <400 即通。死凭据优先：即使先遇到网络错误，只要任一路径返回
 * 401/403（死凭据），最终返回死凭据——连通性测试的核心目的是验证 Key 是否有效。
 * 无廉价无副作用探测的协议（bedrock 等）返回空表：探测是尽力而为，跳过=通过。
 */
import type { ProtocolAdapter } from '../adapters/protocol-adapter';
import { classifyTransportError } from '../errors/classify';
import { tryParseJson } from '../internal/util';
import { fetchUpstream, readBody } from '../transport/http-client';
import type { AiConfig } from '../config';
import type { ChannelDesc, ProbeResult } from '../types';
import { isUpstreamError } from './context';
import { joinUrl } from '../join-url';

export async function probeChannel(deps: {
  channel: ChannelDesc;
  adapter: ProtocolAdapter;
  cfg: AiConfig;
}): Promise<ProbeResult> {
  const { channel, adapter, cfg } = deps;
  const start = Date.now();
  let firstError: ReturnType<typeof adapter.mapError> | undefined;
  // 死凭据优先：见模块注释
  let deadCredError: ReturnType<typeof adapter.mapError> | undefined;
  const probes = adapter.probeRequests(channel);
  // 无探测路径的协议（bedrock 等）：跳过=通过
  if (probes.length === 0) return { ok: true, durationMs: Date.now() - start };
  for (const probe of probes) {
    try {
      const res = await fetchUpstream(
        joinUrl(channel.baseUrl, probe.path),
        { method: 'GET', headers: probe.headers },
        {
          connectMs: cfg.timeout.connectMs,
          allowLocal: cfg.allowLocalUrl,
          allowedHosts: cfg.allowedHosts,
        },
      );
      if (res.status < 400) return { ok: true, durationMs: Date.now() - start };
      const raw = await readBody(res);
      const err = adapter.mapError(res.status, tryParseJson(raw) ?? raw);
      if (err.deadCredential) deadCredError ??= err;
      else firstError ??= err;
    } catch (err) {
      const mapped = isUpstreamError(err) ? err : classifyTransportError('network');
      firstError ??= mapped;
    }
  }
  return {
    ok: false,
    durationMs: Date.now() - start,
    error: deadCredError ?? firstError,
  };
}
