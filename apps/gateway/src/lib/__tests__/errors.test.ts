import { describe, expect, it } from 'vitest';
import { HttpError } from '@ai-gateway/http';
import {
  DailySpendLimitExceededError,
  InsufficientBalanceError,
  BillingBacklogError,
} from '@ai-gateway/ledger';
import {
  GatewayError,
  gatewayError,
  reject,
  translateAuthorizeError,
  translateBoundaryError,
  translateUnknown,
  upstreamPassthroughReject,
} from '../errors.js';

/**
 * 统一错误体系单测（异常风格，2026-08）：
 *   - GatewayError/gatewayError() 从注册表推导状态码（调用点不写状态码）
 *   - translateAuthorizeError 表驱动翻译（ledger 域错误 → throw GatewayError）
 *   - upstreamPassthroughReject 白名单（安全：仅 4xx + 码形状合法才透传）
 *   - 边界翻译：PG 约束 → 4xx、未知异常 → 500 且不泄 message
 */

describe('GatewayError：注册表单一真相', () => {
  it('状态码与默认文案从注册表推导', () => {
    const e = gatewayError('insufficient_balance');
    expect(e).toBeInstanceOf(GatewayError);
    expect(e).toBeInstanceOf(HttpError);
    expect(e.status).toBe(402);
    expect(e.message).toBe('可用余额不足');
  });

  it('只允许覆盖动态部分（message/suggestion/retryAfter）', () => {
    const e = gatewayError('rate_limit_exceeded', { retryAfterSec: 7, message: '自定义文案' });
    expect(e.status).toBe(429);
    expect(e.retryAfterSec).toBe(7);
    expect(e.message).toBe('自定义文案');
    expect(e.headers?.['retry-after']).toBe('7');
  });

  it('toReject() 输出渲染形状（含 retryAfter/log）', () => {
    const e = gatewayError('billing_temporarily_unavailable', {
      log: { pending: 5 },
      retryAfterSec: 3,
    });
    expect(e.toReject()).toMatchObject({
      code: 'billing_temporarily_unavailable',
      status: 503,
      retryAfterSec: 3,
      log: { pending: 5 },
    });
  });

  it('未登记的码直接抛错（编译期外的第二道闸）', () => {
    expect(() => gatewayError('not_a_registered_code' as never)).toThrow();
  });
});

describe('reject()：值形态（渲染/翻译内部用）', () => {
  it('与 GatewayError 同源（注册表推导）', () => {
    const r = reject('model_not_allowed');
    expect(r).toMatchObject({ code: 'model_not_allowed', status: 403 });
  });
});

describe('translateAuthorizeError：授权拒绝表驱动翻译（抛出）', () => {
  const ctx = { maxEstimate: '8.19', reservationMax: '100' };

  it('余额不足 → throw 402 + 动态余额文案', () => {
    expect(() =>
      translateAuthorizeError(new InsufficientBalanceError(1, '0', '0', '0', '0'), ctx),
    ).toThrowError(
      expect.objectContaining({ code: 'insufficient_balance', status: 402 }) as GatewayError,
    );
    try {
      translateAuthorizeError(new InsufficientBalanceError(1, '0', '0', '0', '0'), ctx);
    } catch (e) {
      expect((e as GatewayError).message).toContain('8.19');
      expect((e as GatewayError).suggestion).toBe('请充值后再试');
    }
  });

  it('每日限额（key 维度）→ throw 402 + 维度文案', () => {
    try {
      translateAuthorizeError(new DailySpendLimitExceededError(1, '10', '11', 'key', 5), ctx);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as GatewayError).code).toBe('daily_spend_limit_exceeded');
      expect((e as GatewayError).message).toContain('该 Key（#5）今日');
    }
  });

  it('结算积压 → throw 503 + 携带积压深度日志负载', () => {
    try {
      translateAuthorizeError(new BillingBacklogError(5000, 120_000), ctx);
      throw new Error('should have thrown');
    } catch (e) {
      const ge = e as GatewayError;
      expect(ge.status).toBe(503);
      expect(ge.log).toEqual({ pending: 5000, oldestPendingMs: 120_000 });
    }
  });

  it('未分类异常 → 不抛（调用方上抛为服务端故障）', () => {
    expect(() => translateAuthorizeError(new Error('db down'), ctx)).not.toThrow();
  });
});

describe('upstreamPassthroughReject：上游透传白名单（安全）', () => {
  it('合法 4xx 码 + 形状合法 → 透传', () => {
    const r = upstreamPassthroughReject({
      code: 'context_length_exceeded',
      status: 400,
      message: 'sanitized message',
    });
    expect(r).toMatchObject({ code: 'context_length_exceeded', status: 400 });
  });

  it('5xx 不透传 → 收敛 no_available_channel', () => {
    const r = upstreamPassthroughReject({ code: 'timeout', status: 504, message: 'x' });
    expect(r.code).toBe('no_available_channel');
    expect(r.status).toBe(503);
  });

  it('畸形码（大写/超长/特殊字符）不透传 → 收敛', () => {
    expect(upstreamPassthroughReject({ code: 'BAD CODE!', status: 400, message: 'x' }).code).toBe(
      'no_available_channel',
    );
    expect(
      upstreamPassthroughReject({ code: 'a'.repeat(65), status: 400, message: 'x' }).code,
    ).toBe('no_available_channel');
  });
});

describe('translateBoundaryError：边界统一翻译', () => {
  it('HttpError → 描述符', () => {
    const r = translateBoundaryError(new HttpError('RATE_LIMITED'));
    expect(r).toMatchObject({ code: 'RATE_LIMITED', status: 429 });
  });

  it('GatewayError → 描述符（含 retry-after 头提取）', () => {
    const r = translateBoundaryError(gatewayError('rate_limit_exceeded', { retryAfterSec: 9 }));
    expect(r).toMatchObject({ code: 'rate_limit_exceeded', status: 429, retryAfterSec: 9 });
  });

  it('未知异常 → 500 internal_error，不携带原始 message', () => {
    const r = translateUnknown();
    expect(r).toMatchObject({ code: 'internal_error', status: 500, message: '网关内部错误' });
    expect(r.message).not.toContain('secret');
  });
});
