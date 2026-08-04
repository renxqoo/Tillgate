import { metrics } from '@opentelemetry/api';

/**
 * 网关指标（tech-stack §3.2）。
 * SDK 未启动时（OTEL_ENABLED=false）为 no-op meter，无开销。
 * 启动后通过 OTLP 导出到 collector → Prometheus。
 *
 * 指标清单：
 *   gateway_requests_total{model, status} — 请求量计数
 *   gateway_request_duration_ms{model} — 延迟直方图
 *   gateway_errors_total{error_code} — 错误计数（401/402/429/5xx）
 *   channel_failures_total{channel} — 渠道失败计数
 */
const meter = metrics.getMeter('gateway.metrics');

export const requestCounter = meter.createCounter('gateway_requests_total', {
  description: 'Total requests by model and status',
});

export const requestDuration = meter.createHistogram('gateway_request_duration_ms', {
  description: 'Request duration in ms',
});

export const errorCounter = meter.createCounter('gateway_errors_total', {
  description: 'Errors by error code',
});

export const channelFailureCounter = meter.createCounter('channel_failures_total', {
  description: 'Channel failures by channel key',
});

/** 计量入队失败计数（资损告警：成功请求但计量 job 入队失败 = 漏计费风险） */
export const meterEnqueueFailedCounter = meter.createCounter('meter_enqueue_failed_total', {
  description: 'Meter job enqueue failures (revenue loss risk)',
});

// ---- 便捷方法 ----

export function recordRequest(model: string, status: number, durationMs: number): void {
  requestCounter.add(1, { model, status: String(status) });
  requestDuration.record(durationMs, { model });
}

export function recordError(errorCode: string): void {
  errorCounter.add(1, { error_code: errorCode });
}

export function recordChannelFailure(channelKey: string): void {
  channelFailureCounter.add(1, { channel: channelKey });
}
