/**
 * 异步生成任务操作面（从 create-ai 拆出；仅 tasks 适配器提供）。
 * 轮询为周期性只读，不进重试/熔断——瞬时网络错误归 error，调用方下轮再查。
 */
import type { ProtocolAdapter, ProtocolTaskKind } from '../adapters/protocol-adapter';
import { classifyTransportError } from '../errors/classify';
import { unsupportedProtocolError } from '../errors/internal';
import { tryParseJson } from '../internal/util';
import { fetchUpstream, readBody } from '../transport/http-client';
import type { AiConfig } from '../config';
import type {
  ChannelDesc,
  GenerationFileProbeResult,
  GenerationParsedResponse,
  GenerationTaskProbeResult,
  UpstreamError,
} from '../types';
import { isUpstreamError } from './context';
import { joinUrl } from '../join-url';

export interface GenerationOpsDeps {
  cfg: AiConfig;
  resolveAdapter: (channel: ChannelDesc) => ProtocolAdapter | UpstreamError;
  /** 支持协议清单（unsupportedProtocolError 的报错信息用） */
  supportedProtocols: readonly string[];
}

function taskOpsOf(
  deps: GenerationOpsDeps,
  channel: ChannelDesc,
): { ok: true; adapter: ProtocolAdapter; tasks: NonNullable<ProtocolAdapter['tasks']> } | { ok: false; error: UpstreamError } {
  const adapter = deps.resolveAdapter(channel);
  if ('code' in adapter) return { ok: false, error: adapter };
  const tasks = adapter.tasks;
  if (!tasks) return { ok: false, error: unsupportedProtocolError(channel.protocol, deps.supportedProtocols) };
  return { ok: true, adapter, tasks };
}

/** 任务型端点提交/执行响应解析（video 提交→taskId；music 同步完成→产物） */
export function makeParseGenerationResponse(deps: GenerationOpsDeps) {
  return (input: {
    channel: ChannelDesc;
    kind: ProtocolTaskKind;
    body: unknown;
  }): GenerationParsedResponse => {
    const ops = taskOpsOf(deps, input.channel);
    if (!ops.ok) return { kind: 'error', error: ops.error };
    return ops.tasks.parseResponse(input.kind, input.body);
  };
}

/** 上游任务状态查询（video 轮询用） */
export function makeQueryGenerationTask(deps: GenerationOpsDeps) {
  return async (input: {
    channel: ChannelDesc;
    taskId: string;
  }): Promise<GenerationTaskProbeResult> => {
    const ops = taskOpsOf(deps, input.channel);
    if (!ops.ok) return { ok: false, error: ops.error };
    const plan = ops.tasks.planTaskQuery(input.channel, input.taskId);
    try {
      const res = await fetchUpstream(
        joinUrl(input.channel.baseUrl, plan.path),
        { method: 'GET', headers: plan.headers },
        {
          connectMs: deps.cfg.timeout.connectMs,
          allowLocal: deps.cfg.allowLocalUrl,
          allowedHosts: deps.cfg.allowedHosts,
        },
      );
      if (res.status >= 400) {
        const raw = await readBody(res);
        return { ok: false, error: ops.adapter.mapError(res.status, tryParseJson(raw) ?? raw) };
      }
      const raw = await readBody(res);
      return ops.tasks.parseTaskStatus(tryParseJson(raw));
    } catch (err) {
      // 轮询是周期性的：瞬时网络错误归 error，调用方下轮再查（不重试单次）
      return {
        ok: false,
        error: isUpstreamError(err) ? err : classifyTransportError('network'),
      };
    }
  };
}

/** 上游产物取回（succeeded 后换取下载 URL） */
export function makeRetrieveGenerationFile(deps: GenerationOpsDeps) {
  return async (input: {
    channel: ChannelDesc;
    fileId: string;
  }): Promise<GenerationFileProbeResult> => {
    const ops = taskOpsOf(deps, input.channel);
    if (!ops.ok) return { ok: false, error: ops.error };
    if (!ops.tasks.planFileRetrieve || !ops.tasks.parseFileRetrieve) {
      return { ok: false, error: unsupportedProtocolError(input.channel.protocol, deps.supportedProtocols) };
    }
    const plan = ops.tasks.planFileRetrieve(input.channel, input.fileId);
    try {
      const res = await fetchUpstream(
        joinUrl(input.channel.baseUrl, plan.path),
        { method: 'GET', headers: plan.headers },
        {
          connectMs: deps.cfg.timeout.connectMs,
          allowLocal: deps.cfg.allowLocalUrl,
          allowedHosts: deps.cfg.allowedHosts,
        },
      );
      if (res.status >= 400) {
        const raw = await readBody(res);
        return { ok: false, error: ops.adapter.mapError(res.status, tryParseJson(raw) ?? raw) };
      }
      const raw = await readBody(res);
      return ops.tasks.parseFileRetrieve(tryParseJson(raw));
    } catch (err) {
      return {
        ok: false,
        error: isUpstreamError(err) ? err : classifyTransportError('network'),
      };
    }
  };
}
