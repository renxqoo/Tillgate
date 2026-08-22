import { UpstreamError } from './kinds';

/**
 * 包内策略性错误（非上游响应分类——厂商错误归一见 errors/kinds + adapter 错误表）：
 * 传输与库策略错误生成时直接带 kind，机制位由派生表得出。
 */

/** 空完成：HTTP 200 但无内容。重试由 withRetry 的 empty 标志驱动（独立预算） */
export const emptyError = (): UpstreamError =>
  new UpstreamError({ kind: 'empty_completion', message: 'upstream returned empty completion (HTTP 200, no content)' });

/** 响应格式非法：200 但非 JSON，或响应体超限 */
export const invalidResponseError = (message = 'upstream returned non-JSON body'): UpstreamError =>
  new UpstreamError({ kind: 'invalid_response', message });

/** 重试总 deadline 到（withRetry 的 AbortSignal 触发）或调用方取消 */
export const canceledError = (message = 'retry deadline exceeded'): UpstreamError =>
  new UpstreamError({ kind: 'canceled', message });

/** 服务端 drain 中止（宽限期后 ServerDrainAbort）：本进程责任，不计熔断、不换渠道 */
export const serverDrainingError = (): UpstreamError =>
  new UpstreamError({ kind: 'server_draining', message: 'gateway shutting down' });

/** 协议不支持：channel.protocol 不是已注册适配器之一（配置错误，显式报错而非静默回退） */
export const unsupportedProtocolError = (protocol: string, supported: readonly string[]): UpstreamError =>
  new UpstreamError({
    kind: 'unsupported_protocol',
    message: `unsupported protocol: ${protocol} (registered: ${supported.join(', ')})`,
    suggestion: `请检查渠道协议配置（当前已注册适配器: ${supported.join(', ')}）`,
  });

/** 任务型操作面向未注册任务协议的适配器调用（B6：与真实「上游未返回 taskId」区分） */
export const taskOpsUnavailableError = (protocol: string): UpstreamError =>
  new UpstreamError({
    kind: 'task_ops_unavailable',
    message: `protocol ${protocol} does not provide generation task ops`,
    suggestion: '请检查渠道协议配置（任务族端点需要任务型协议，如 minimax）',
  });

/** 配置非法：ChannelDesc/CallOptions/request 必需字段缺失或为空（调用方 bug，不发垃圾请求） */
export const invalidConfigError = (message: string): UpstreamError =>
  new UpstreamError({
    kind: 'invalid_config',
    message,
    suggestion: '请检查渠道/请求配置（apiKey、baseUrl、model 等必需字段）',
  });
