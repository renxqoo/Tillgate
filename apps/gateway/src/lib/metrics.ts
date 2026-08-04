import { metrics, type Counter, type Histogram, type Meter } from '@opentelemetry/api';

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
 *   meter_enqueue_failed_total — 计量入队失败（资损告警）
 *
 * Lazy 初始化：模块加载时 OTel SDK 可能还没 start（ES import 提升），
 * 延迟到首次调用时才 getMeter，确保拿到的是 SDK 注册的真实 meter（非 no-op）。
 */

let cachedMeter: Meter | null = null;
let cachedRequestCounter: Counter | null = null;
let cachedRequestDuration: Histogram | null = null;
let cachedErrorCounter: Counter | null = null;
let cachedChannelFailureCounter: Counter | null = null;
let cachedMeterEnqueueFailedCounter: Counter | null = null;

function meter(): Meter {
  if (!cachedMeter) {
    cachedMeter = metrics.getMeter('gateway.metrics');
    cachedRequestCounter = cachedMeter.createCounter('gateway_requests_total', {
      description: 'Total requests by model and status',
    });
    cachedRequestDuration = cachedMeter.createHistogram('gateway_request_duration_ms', {
      description: 'Request duration in ms',
    });
    cachedErrorCounter = cachedMeter.createCounter('gateway_errors_total', {
      description: 'Errors by error code',
    });
    cachedChannelFailureCounter = cachedMeter.createCounter('channel_failures_total', {
      description: 'Channel failures by channel key',
    });
    cachedMeterEnqueueFailedCounter = cachedMeter.createCounter('meter_enqueue_failed_total', {
      description: 'Meter job enqueue failures (revenue loss risk)',
    });
  }
  return cachedMeter;
}

// 向后兼容导出（duck-type 对象，首次调用触发 lazy 初始化）
export const requestCounter = { add(n: number, attrs: Record<string, string> = {}) { meter(); cachedRequestCounter!.add(n, attrs); } };
export const requestDuration = { record(ms: number, attrs: Record<string, string> = {}) { meter(); cachedRequestDuration!.record(ms, attrs); } };
export const errorCounter = { add(n: number, attrs: Record<string, string> = {}) { meter(); cachedErrorCounter!.add(n, attrs); } };
export const channelFailureCounter = { add(n: number, attrs: Record<string, string> = {}) { meter(); cachedChannelFailureCounter!.add(n, attrs); } };
export const meterEnqueueFailedCounter = { add(n: number, attrs: Record<string, string> = {}) { meter(); cachedMeterEnqueueFailedCounter!.add(n, attrs); } };

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
