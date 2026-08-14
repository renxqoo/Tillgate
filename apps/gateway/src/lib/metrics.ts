import { getMeter } from '@ai-gateway/core';
import type { Counter, Histogram, Meter } from '@opentelemetry/api';

/**
 * 网关指标（tech-stack §3.2）。
 * SDK 未启动时（OTEL_TRACES_MODE=off 或非 otlp 模式）为 no-op meter，无开销。
 * 启动后通过 OTLP 导出到 collector → Prometheus。
 *
 * 指标清单：
 *   gateway_requests_total{model, status} — 请求量计数
 *   gateway_request_duration_ms{model} — 延迟直方图
 *   gateway_errors_total{error_code} — 错误计数（401/402/429/5xx）
 *   channel_failures_total{channel} — 渠道失败计数
 *   billing_wakeup_failed_total — 结算唤醒失败（DB sweeper 会恢复）
 *
 * Lazy 初始化：模块加载时 OTel SDK 可能还没 start（ES import 提升），
 * 延迟到首次调用时才 getMeter，确保拿到的是 SDK 注册的真实 meter（非 no-op）。
 */

let cachedMeter: Meter | null = null;
let cachedRequestCounter: Counter | null = null;
let cachedRequestDuration: Histogram | null = null;
let cachedErrorCounter: Counter | null = null;
let cachedChannelFailureCounter: Counter | null = null;
let cachedBillingWakeupFailedCounter: Counter | null = null;

function meter(): Meter {
  if (!cachedMeter) {
    cachedMeter = getMeter('gateway.metrics');
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
    cachedBillingWakeupFailedCounter = cachedMeter.createCounter('billing_wakeup_failed_total', {
      description: 'Billing wakeup failures; durable DB sweeper recovery remains active',
    });
  }
  return cachedMeter;
}

export function recordRequest(model: string, status: number, durationMs: number): void {
  meter();
  cachedRequestCounter!.add(1, { model, status: String(status) });
  cachedRequestDuration!.record(durationMs, { model });
}

export function recordError(errorCode: string): void {
  meter();
  cachedErrorCounter!.add(1, { error_code: errorCode });
}

export function recordChannelFailure(channelKey: string): void {
  meter();
  cachedChannelFailureCounter!.add(1, { channel: channelKey });
}

export function recordBillingWakeupFailed(): void {
  meter();
  cachedBillingWakeupFailedCounter!.add(1);
}
