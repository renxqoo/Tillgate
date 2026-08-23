/**
 * gateway 错误面（v1 error-map 的 v2 目录形态，DESIGN §2.3 / R-E1）：
 * - app 自有目录 gateway.*（路由层协议码）；
 * - 装配组合目录（http + inference + billing + accounts + observability）经
 *   `composeErrorCatalogs` 单面渲染，status 由 category 默认表 + face override 决定；
 * - 上游 502/504 网关语义、429 Retry-After、OAuth 标准错误形在各自的出口表达。
 * status/触发条件与 v1 24 条 instance 表逐项等价（MIGRATION §4 核销表）。
 */
import { defineErrorCatalog, composeErrorCatalogs, type ErrorCatalog } from '@tokenlens/errors';
import { HttpErrors, type FaceOverride } from '@tokenlens/http';
import { InferenceErrors } from '@tokenlens/inference';
import { BillingErrors } from '@tokenlens/billing';
import { AccountsErrors } from '@tokenlens/accounts';
import { observabilityErrors } from '@tokenlens/observability';

/** gateway 自有协议码（§11：message 英文、zh 必填） */
export const GatewayErrors = defineErrorCatalog('gateway', {
  invalid_body: {
    category: 'invalid_input',
    message: 'Invalid request body',
    zh: '请求体非法',
  },
  rate_limit_exceeded: {
    category: 'rate_limited',
    message: 'Rate limit exceeded',
    zh: '请求频率超限',
  },
  unsupported_grant_type: {
    category: 'invalid_input',
    message: 'Only client_credentials is supported',
    zh: '仅支持 client_credentials 授权类型',
  },
  invalid_client: {
    category: 'forbidden',
    message: 'Invalid client credentials',
    zh: '客户端凭证无效',
  },
});

/** 组合目录（装配一次；命名空间冲突装配期即抛） */
export function gatewayErrorCatalog(): ErrorCatalog {
  return composeErrorCatalogs(
    GatewayErrors,
    HttpErrors,
    InferenceErrors,
    BillingErrors,
    AccountsErrors,
    observabilityErrors,
  );
}

/**
 * face 出站差异（renderError overrides）：
 * - v1 语义里 forbidden 默认 403，鉴权失败必须 401 → unauthorized/invalidate 升 401；
 * - inference.upstream_failed 是 502 网关语义（category unavailable 默认 503）；
 * - OAuth invalid_client 出站走 OAuth 标准错误形（oauthErrorBody），不经本表。
 */
export const GATEWAY_FACE_OVERRIDES: Readonly<Record<string, FaceOverride>> = Object.freeze({
  [HttpErrors.code('unauthorized')]: { status: 401 },
  [InferenceErrors.code('upstream_failed')]: { status: 502 },
});

/** v1 wire 码 → v2 目录码对照（断言迁移核销用；码表封闭性由 catalog 保证） */
export const LEGACY_CODE_MAP: Readonly<Record<string, string>> = Object.freeze({
  invalid_body: GatewayErrors.code('invalid_body'),
  rate_limit_exceeded: GatewayErrors.code('rate_limit_exceeded'),
  unauthorized: HttpErrors.code('unauthorized'),
  not_found: HttpErrors.code('not_found'),
  payload_too_large: HttpErrors.code('payload_too_large'),
  model_not_found: InferenceErrors.code('model_not_found'),
  model_not_allowed: InferenceErrors.code('model_not_allowed'),
  no_available_channel: InferenceErrors.code('no_available_channel'),
  upstream_failed: InferenceErrors.code('upstream_failed'),
  finalize_unavailable: InferenceErrors.code('finalize_unavailable'),
});
