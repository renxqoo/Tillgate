import { describe, expect, it } from 'vitest';
import { BillingStateConflictError, InsufficientBalanceError } from '@ai-gateway/ledger';
import { mapAuthorizeRejection } from './authorize-rejection.js';

/**
 * 红测（F5）：BillingStateConflictError 不在授权拒绝表里 → 未分类 → 网关 500。
 * 同 requestId 携带不同授权内容（重试改了请求体）是可预期的客户端冲突，
 * 必须翻译为 409 + 业务码，而不是伪装成服务端故障。
 */

const ctx = { maxEstimate: '1.00', reservationMax: '50' };

describe('授权拒绝翻译（F5 红测）', () => {
  it('BillingStateConflictError → 409 authorization_conflict', () => {
    const rejection = mapAuthorizeRejection(
      new BillingStateConflictError('req-1', 'authorization replay conflict'),
      ctx,
    );
    expect(rejection).not.toBeNull();
    expect(rejection!.status).toBe(409);
    expect(rejection!.code).toBe('authorization_conflict');
  });

  it('已知余额类错误仍按原语义翻译（回归护栏）', () => {
    const rejection = mapAuthorizeRejection(new InsufficientBalanceError(1, '0'), ctx);
    expect(rejection!.status).toBe(402);
    expect(rejection!.code).toBe('insufficient_balance');
  });
});
