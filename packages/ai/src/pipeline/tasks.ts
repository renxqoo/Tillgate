/**
 * generation 任务操作组（parse/query/file，从 create-ai 拆出——动词一文件）。
 * 只做协议任务的只读探测与解析；任务提交/轮询编排在 inference。
 */
import type {
  ChannelDesc,
  GenerationFileProbeResult,
  GenerationParsedResponse,
  GenerationTaskProbeResult,
  UpstreamError,
} from '../types';
import type { Ai } from '../types';
import type { AiDefaults, AiDeps } from '../config';
import type { ProtocolAdapter } from '../adapters/protocol-adapter';
import { UpstreamError as UE } from '../errors/kinds';
import { taskOpsUnavailableError } from '../errors/internal';
import { fetchUpstream, readBody } from '../transport/http-client';
import { tryParseJson } from '../internal/json';
import { joinUrl } from '../join-url';

export interface TaskOpsEnv {
  adapters: Map<string, ProtocolAdapter>;
  resolveAdapter(channel: ChannelDesc): ProtocolAdapter | UpstreamError;
  cfg: AiDefaults;
  guard: AiDeps['guardUrl'];
}

/** GET 探测公共执行段（query/file 共用）：传输 → 读体 → 非 2xx 厂商错误映射 / 2xx 交协议解析 */
async function fetchTaskProbe(input: {
  channel: ChannelDesc;
  path: string;
  headers: Record<string, string>;
  adapter: ProtocolAdapter;
  cfg: AiDefaults;
  guard: AiDeps['guardUrl'];
}): Promise<{ ok: true; body: unknown } | { ok: false; error: UpstreamError }> {
  const { channel, path, headers, adapter, cfg, guard } = input;
  try {
    const res = await fetchUpstream(
      joinUrl(channel.baseUrl, path),
      { method: 'GET', headers },
      { connectMs: cfg.timeout.connectMs, guard },
    );
    const raw = await readBody(res);
    const body = tryParseJson(raw) ?? raw;
    if (!res.ok) return { ok: false, error: adapter.mapError(res.status, body) };
    return { ok: true, body };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof UE ? error : new UE({ kind: 'network', message: String(error) }),
    };
  }
}

export function createTaskOps(env: TaskOpsEnv): Ai['tasks'] {
  const { adapters, resolveAdapter, cfg, guard } = env;
  const opsOf = (channel: ChannelDesc) => {
    const a = resolveAdapter(channel);
    if (a instanceof UE) return a;
    return a.tasks ?? null;
  };
  return {
    parse: (channel, kind, body): GenerationParsedResponse => {
      const ops = opsOf(channel);
      if (ops instanceof UE) return { kind: 'error', error: ops };
      if (ops === null) return { kind: 'error', error: taskOpsUnavailableError(channel.protocol) };
      return ops.parseResponse(kind, body);
    },
    query: async (channel, taskId): Promise<GenerationTaskProbeResult> => {
      const ops = opsOf(channel);
      if (ops instanceof UE) return { ok: false, error: ops };
      if (ops === null) return { ok: false, error: taskOpsUnavailableError(channel.protocol) };
      const plan = ops.planTaskQuery(channel, taskId);
      const probe = await fetchTaskProbe({
        channel,
        path: plan.path,
        headers: plan.headers,
        adapter: adapters.get(channel.protocol) as ProtocolAdapter,
        cfg,
        guard,
      });
      if (!probe.ok) return probe;
      return ops.parseTaskStatus(probe.body);
    },
    file: async (channel, fileId): Promise<GenerationFileProbeResult> => {
      const ops = opsOf(channel);
      if (ops instanceof UE) return { ok: false, error: ops };
      if (ops === null) return { ok: false, error: taskOpsUnavailableError(channel.protocol) };
      const plan = ops.planFileRetrieve(channel, fileId);
      const probe = await fetchTaskProbe({
        channel,
        path: plan.path,
        headers: plan.headers,
        adapter: adapters.get(channel.protocol) as ProtocolAdapter,
        cfg,
        guard,
      });
      if (!probe.ok) return probe;
      return ops.parseFileRetrieve(probe.body);
    },
  };
}
