/**
 * 错误面契约：
 * 组合目录封闭 / status 分派链（category 默认 + face override 502）/ 信封形状。
 * 上游细节脱敏（内容层）在 inference dispatchFailure 单点收口（其 failover 测试锁定）。
 */
import { describe, expect, it } from 'vitest';
import { renderError } from '@tillgate/http';
import { InfrastructureError } from '@tillgate/errors';
import { BillingErrors } from '@tillgate/billing';
import { InferenceErrors } from '@tillgate/inference';
import {
  GatewayErrors,
  GATEWAY_FACE_OVERRIDES,
  gatewayErrorCatalog,
  LEGACY_CODE_MAP,
} from '../src/http/openai-error-face';

const catalog = gatewayErrorCatalog();

function render(error: unknown) {
  return renderError(error, { catalog, overrides: GATEWAY_FACE_OVERRIDES });
}

describe('目录组合', () => {
  it('五目录合一面：命名空间全覆盖且互不冲突', () => {
    for (const code of [
      'gateway.invalid_body',
      'http.unauthorized',
      'inference.model_not_found',
      'billing.insufficient_balance',
      'accounts.key_not_found',
      'observability.otel_endpoint_missing',
    ]) {
      expect(catalog.has(code), code).toBe(true);
    }
  });

  it('v1 wire 码对照表全部命中组合目录（R-E1 核销锚）', () => {
    for (const [legacy, modern] of Object.entries(LEGACY_CODE_MAP)) {
      expect(catalog.has(modern), `${legacy} → ${modern}`).toBe(true);
    }
  });
});

describe('status 分派（v1 24 条表的 v2 形态；逐类代表核销）', () => {
  it.each([
    [BillingErrors.business('insufficient_balance'), 402],
    [BillingErrors.business('daily_spend_limit'), 402],
    [BillingErrors.business('subscription_required'), 402],
    [BillingErrors.business('account_frozen'), 403],
    [BillingErrors.business('idempotency_conflict'), 409],
    [BillingErrors.business('authorization_not_active'), 409],
    [BillingErrors.business('settle_exceeds_hold'), 400],
    [BillingErrors.business('state_conflict'), 409],
    [InferenceErrors.business('model_not_found'), 404],
    [InferenceErrors.business('model_not_allowed'), 403],
    [InferenceErrors.business('no_available_channel'), 503],
    [InferenceErrors.business('finalize_unavailable'), 503],
    [GatewayErrors.business('rate_limit_exceeded'), 429],
    [GatewayErrors.business('invalid_body'), 400],
  ])('status 由 category 默认表定（%#）', (error, status) => {
    expect(render(error).status).toBe(status);
  });

  it('上游故障全败 = 502（face override；category unavailable 默认 503 的例外）', () => {
    const rendered = render(InferenceErrors.business('upstream_failed'));
    expect(rendered.status).toBe(502);
    expect(rendered.code).toBe('inference.upstream_failed');
  });

  it('基建故障 = 503 + 身份码保留 + 通用文案（v1 rate_limiter_unavailable 同语义）', () => {
    const infra = render(new InfrastructureError('boom', 'runtime.rate_limit_unavailable'));
    expect(infra.status).toBe(503);
    expect(infra.code).toBe('runtime.rate_limit_unavailable');
    expect(infra.message).not.toContain('boom');
  });

  it('未知错误 = 500 + errors.unhandled（细节只进日志）', () => {
    const rendered = render(new Error('secret detail'));
    expect(rendered.status).toBe(500);
    expect(rendered.code).toBe('errors.unhandled');
    expect(rendered.message).not.toContain('secret');
  });
});
