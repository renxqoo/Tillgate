/** 单码作废（CAS 0→2——已用/已废/不存在统一 404 不泄漏状态差异） */
import { BillingErrors } from '../../domain/errors.js';
import type { BillingStore } from '../../ports/billing-store.js';
import type { RedeemCodeStore } from '../../ports/payment-ports.js';

export async function revokeCode(
  env: { store: Pick<BillingStore, 'transaction'>; codes: Pick<RedeemCodeStore, 'revokeCode'> },
  input: { codeId: number },
): Promise<{ ok: true }> {
  const revoked = await env.store.transaction((tx) => env.codes.revokeCode(tx, input));
  if (!revoked) {
    throw BillingErrors.business('redeem_code_not_found', { codeId: String(input.codeId) });
  }
  return { ok: true };
}
