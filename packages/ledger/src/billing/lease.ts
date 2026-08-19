/** billing 租约与指纹设施（S5 重写收口：leaseUntil + 事件指纹）。 */
import { fingerprintOf } from '@ai-gateway/ledger-core';
import { BillingConfigurationError } from '../platform/errors.js';

/** 租约末点 = now + leaseMs（非法配置结构拒绝） */
export function leaseUntil(now: Date, leaseMs: number): Date {
  if (!Number.isFinite(leaseMs) || leaseMs <= 0)
    throw new BillingConfigurationError('invalid_quote');
  return new Date(now.getTime() + leaseMs);
}

/** canonical 指纹（ledger-core 同源；收据/授权重放比对） */
export function billingFingerprint(value: unknown): string {
  return fingerprintOf(value);
}
