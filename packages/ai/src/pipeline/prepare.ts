/**
 * per-request 组装：参数抹平 + 熔断/死凭据准入对象创建（从 create-ai 拆出）。
 * 规则唯一来源：ctx.paramRules（DB per-model），无 provider 内置默认。
 */
import { CircuitBreaker } from '../breaker/breaker';
import { DeadCredentialTracker } from '../dead-credential/tracker';
import type { ProtocolAdapter } from '../adapters/protocol-adapter';
import type { AiConfig } from '../config';
import type { BreakerStorage, DeadCredentialStorage } from '../config';
import type { AiEvent } from '../events';
import type { ChannelDesc, RequestCtx, UpstreamError } from '../types';
import { mergeParamRules, resolveVendorProfile } from '../registry/vendor-profiles';
import { assertChannelAndCtx, channelKey } from './context';

export type PreparedRequest =
  | {
      ok: true;
      body: unknown;
      breaker: CircuitBreaker;
      credential: DeadCredentialTracker;
      adapter: ProtocolAdapter;
      key: string;
    }
  | { ok: false; error: UpstreamError };

export interface PrepareDeps {
  cfg: AiConfig;
  breakerStorage: BreakerStorage;
  deadCredentialStorage: DeadCredentialStorage;
  /** 协议解析（注册表查询；未知协议返回错误） */
  resolveAdapter: (channel: ChannelDesc) => ProtocolAdapter | UpstreamError;
  log: { info: (msg: string, ...args: unknown[]) => void };
  emit: (e: AiEvent) => void;
}

export function createPrepare(deps: PrepareDeps) {
  const breakerFor = (channel: ChannelDesc): CircuitBreaker =>
    new CircuitBreaker(channelKey(channel), deps.cfg.breaker, deps.breakerStorage, Date.now);

  const credentialFor = (channel: ChannelDesc): DeadCredentialTracker =>
    new DeadCredentialTracker(
      channelKey(channel),
      deps.cfg.deadCredential,
      deps.deadCredentialStorage,
      Date.now,
      // 软防护翻转事件（gateway 订阅投 channel_disabled 告警）——闭包捕获渠道身份
      () =>
        deps.emit({
          type: 'channel_dead_credential',
          channelId: channel.channelId ?? -1,
          channelName: channel.channelName ?? 'unknown',
        }),
    );

  return function prepare(input: { channel: ChannelDesc; request: unknown; ctx: RequestCtx }): PreparedRequest {
    // 配置校验（fail fast）：必需字段为空时直接返回错误，不发垃圾请求
    const cfgErr = assertChannelAndCtx(input.channel, input.ctx);
    if (cfgErr) return { ok: false, error: cfgErr };
    const adapter = deps.resolveAdapter(input.channel);
    if ('code' in adapter) return { ok: false, error: adapter };
    // 参数抹平规则：vendor profile（厂商家族怪癖默认）+ per-model 规则（DB，优先），
    // 编译进单一执行引擎（adapter.normalizeRequest 的 ignore→map→clamp）
    const profile = resolveVendorProfile(input.channel.vendor);
    const rules = mergeParamRules(profile?.params, input.ctx.paramRules);
    const { body, adjustments } = adapter.normalizeRequest(input.request, rules);
    // model 重写与 stream_options 注入等协议特定终改由 adapter.finalizeRequestBody
    // 在发往上游前完成（chat/chatStream 入口调用），编排层不再出现协议字面量。
    for (const a of adjustments) {
      deps.log.info(`[ai] ${input.ctx.requestId} param_adjustment ${a.action} ${a.param}`, {
        from: a.from,
        to: a.to,
      });
      // B4：参数抹平产出 param_adjustment 事件（gateway 排障可观测）
      deps.emit({
        type: 'param_adjustment',
        requestId: input.ctx.requestId,
        param: a.param,
        action: a.action,
        from: a.from,
        to: a.to,
      });
    }
    return {
      ok: true,
      body,
      breaker: breakerFor(input.channel),
      credential: credentialFor(input.channel),
      adapter,
      key: channelKey(input.channel),
    };
  };
}
